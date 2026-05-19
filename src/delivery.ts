import { join } from 'node:path'
import type { Context } from './effects.ts'
import { sanitizeId } from './identity.ts'
import { asStringField } from './inbox.ts'

/** How long a single `mcp.notify` is given to settle before being
 *  classified as wedged. The SDK can hang forever on EPIPE; this cap
 *  is the only reason the bun survives a parent-pipe close. */
export const PUSH_TIMEOUT_MS = 5_000

/** Window within which we expect to see the msg_id appear in the
 *  recipient's own CC JSONL after `mcp.notify` resolves. A miss after
 *  this window indicates CC silently dropped the channel push. */
export const JSONL_VERIFY_TIMEOUT_MS = 5_000

/** Poll cadence for the JSONL append-only probe. */
export const JSONL_VERIFY_POLL_MS = 250

/** After this many consecutive push timeouts, `.wedged` is written
 *  so external monitors (doctor, peers) can see the bun is alive but
 *  its push channel is dropping. */
export const WEDGE_TIMEOUT_THRESHOLD = 3

/** Outcome of a {@link withTimeout} race. */
export interface TimeoutResult {
  status: 'ok' | 'timeout'
}

/** Wrap a promise with a timeout. The setTimeout is cleared as soon as the
 *  promise settles — no zombie timers accumulate on the hot path.
 *  Rejections are surfaced via ctx.proc.stderr (caller logs them once)
 *  rather than swallowed via .then(()=>'ok').catch antipattern. */
export async function withTimeout<T>(
  ctx: Pick<Context, 'clock' | 'proc'>,
  task: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<'ok' | 'timeout'> {
  let cleared = false
  let timerHandle: { clear(): void } | undefined
  const timeoutP = new Promise<'timeout'>(resolve => {
    timerHandle = ctx.clock.setTimeout(() => {
      if (!cleared) resolve('timeout')
    }, timeoutMs)
  })
  try {
    const result = await Promise.race<'ok' | 'timeout'>([
      task.then(
        () => 'ok' as const,
        err => {
          const message = err instanceof Error ? err.message : String(err)
          ctx.proc.stderr(`[choros] ${label} rejected: ${message}\n`)
          return 'ok' as const
        },
      ),
      timeoutP,
    ])
    return result
  } finally {
    cleared = true
    timerHandle?.clear()
  }
}

// Monotonic counter to disambiguate concurrent atomicWrite calls from the
// same pid. Without this, two writers racing on the same path produced
// identical tmp filenames; one overwrote the other's tmp and only one
// rename's content survived.
let atomicWriteCounter = 0

/** Tmp+rename so concurrent readers never see a half-written payload.
 *  The tmp filename includes pid AND a monotonic counter so two writers
 *  from the same process never collide on the tmp path. */
export async function atomicWrite(
  ctx: Pick<Context, 'fs' | 'proc'>,
  path: string,
  content: string,
): Promise<void> {
  atomicWriteCounter = (atomicWriteCounter + 1) & 0xffffffff
  const tmp = `${path}.${ctx.proc.pid()}.${atomicWriteCounter}.tmp`
  await ctx.fs.writeFile(tmp, content)
  await ctx.fs.rename(tmp, path)
}

/** Poll an own-CC JSONL for a substring match on msg_id. Uses an append-only
 *  window — the search only considers bytes written AFTER the call started,
 *  so an older record that happened to embed the msg_id literal cannot
 *  false-positive. Returns true on first match within `timeoutMs`. */
export async function verifyJsonlReceipt(
  ctx: Pick<Context, 'fs' | 'clock'>,
  jsonl: string | null,
  msgId: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!msgId) return false
  if (!jsonl) return true
  let startSize: number
  try {
    startSize = (await ctx.fs.stat(jsonl)).size
  } catch {
    startSize = 0
  }
  const deadline = ctx.clock.nowMs() + timeoutMs
  while (ctx.clock.nowMs() < deadline) {
    try {
      const s = await ctx.fs.stat(jsonl)
      if (s.size > startSize) {
        const raw = await ctx.fs.readFile(jsonl)
        const tail = raw.length > startSize ? raw.slice(startSize) : ''
        if (tail.includes(msgId)) return true
      }
    } catch {
      /* keep polling */
    }
    await waitMs(ctx, JSONL_VERIFY_POLL_MS)
  }
  return false
}

function waitMs(ctx: Pick<Context, 'clock'>, ms: number): Promise<void> {
  return new Promise(resolve => {
    ctx.clock.setTimeout(() => resolve(), ms)
  })
}

/** Mutable counter the bun threads through every push so wedge detection
 *  can observe consecutive failures across calls. */
export interface WedgeState {
  consecutiveTimeouts: number
}

/** Push a channel notification with timeout + wedge bookkeeping. On `ok`,
 *  consecutiveTimeouts resets to 0 and clearWedge() is invoked. On timeout,
 *  it increments and `.wedged` is written after WEDGE_TIMEOUT_THRESHOLD. */
export async function pushChannelNotification(
  ctx: Pick<Context, 'mcp' | 'clock' | 'proc' | 'fs'>,
  state: WedgeState,
  wedgePath: string,
  msgId: string,
  content: string,
  meta: Record<string, string>,
): Promise<'ok' | 'timeout'> {
  const result = await withTimeout(
    ctx,
    ctx.mcp.notify('notifications/claude/channel', { content, meta }),
    PUSH_TIMEOUT_MS,
    `push msg_id=${msgId}`,
  )
  if (result === 'ok') {
    if (state.consecutiveTimeouts > 0) {
      ctx.proc.stderr(
        `[choros] push resolved — clearing wedge (was ${state.consecutiveTimeouts})\n`,
      )
      state.consecutiveTimeouts = 0
      try {
        await ctx.fs.unlink(wedgePath)
      } catch {
        /* not wedged */
      }
    }
    return 'ok'
  }
  state.consecutiveTimeouts++
  ctx.proc.stderr(
    `[choros] push timed out for msg_id=${msgId} (consecutive=${state.consecutiveTimeouts})\n`,
  )
  if (state.consecutiveTimeouts >= WEDGE_TIMEOUT_THRESHOLD) {
    const payload = JSON.stringify({
      pid: ctx.proc.pid(),
      detected_at: ctx.clock.nowIso(),
      consecutive_timeouts: state.consecutiveTimeouts,
      pending_msg_ids: [msgId],
    })
    try {
      await atomicWrite(ctx, wedgePath, payload)
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e)
      ctx.proc.stderr(`[choros] wedge marker write failed: ${m}\n`)
    }
  }
  return 'timeout'
}

/** Identity + state-root needed to write an ack file into a sender's
 *  `sent_acks/` dir. */
export interface AckTargets {
  stateRoot: string
  me: string
  myName: string
}

/** Drop a tiny ack file in the sender's sent_acks/ dir. Idempotent across
 *  msg_id: if any ack-type file already exists for this msg_id, skip the
 *  write. Cross-status dedup: a `.ack` blocks a future `.dropped` and vice
 *  versa — first observation wins. Uses tmp+rename. */
export async function writeAckToSender(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc'>,
  targets: AckTargets,
  msg: { from_session?: unknown; id?: unknown },
  status: 'delivered' | 'dropped',
  recipientPid: number,
): Promise<'written' | 'skipped'> {
  let fromSession: string
  let msgId: string
  try {
    fromSession = asStringField(msg.from_session, 'writeAckToSender.from_session')
    msgId = asStringField(msg.id, 'writeAckToSender.id')
  } catch {
    // Non-string field; an attacker-controlled inbound msg sent
    // `from_session: {}` which `String(value ?? '')` would coerce to
    // "[object Object]" and corrupt routing.
    return 'skipped'
  }
  if (!fromSession || !msgId) return 'skipped'
  if (fromSession === targets.me) return 'skipped'
  // Sanitize before path construction: from_session arrives from inbound msg
  // body, can be attacker-controlled, must not contain ../ or path separators.
  try {
    sanitizeId(fromSession, 'writeAckToSender.from_session')
    sanitizeId(msgId, 'writeAckToSender.msg_id')
  } catch {
    return 'skipped'
  }
  const ext = status === 'delivered' ? 'ack' : 'dropped'
  const otherExt = ext === 'ack' ? 'dropped' : 'ack'
  const senderAcksDir = join(targets.stateRoot, fromSession, 'sent_acks')
  await ctx.fs.mkdir(senderAcksDir, { recursive: true })
  const path = join(senderAcksDir, `${msgId}.${ext}`)
  if (ctx.fs.existsSync(path)) return 'skipped'
  if (ctx.fs.existsSync(join(senderAcksDir, `${msgId}.${otherExt}`))) return 'skipped'
  const payload = JSON.stringify({
    msg_id: msgId,
    status,
    from_session: fromSession,
    to_session: targets.me,
    to_name: targets.myName,
    verified_at: ctx.clock.nowIso(),
    recipient_pid: recipientPid,
  })
  await atomicWrite(ctx, path, payload)
  return 'written'
}
