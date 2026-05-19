import { join } from 'node:path'
import type { Context } from '#choros/effects.ts'
import { sanitizeId } from '#choros/identity.ts'
import { asStringField } from '#choros/inbox.ts'

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
// same pid. Two writers from the same pid on the same path would otherwise
// produce identical tmp filenames and one rename's content would be lost.
let atomicWriteCounter = 0

/** Tmp+rename so concurrent readers never see a half-written payload.
 *  The tmp filename includes pid AND a monotonic counter so two writers
 *  from the same process never collide on the tmp path.
 *
 *  @remarks
 *  The tmp file is created next to the destination so the rename is
 *  almost always intra-filesystem. If a future deployment puts the
 *  state root and tmp on different filesystems (EXDEV), the writeFile
 *  fallback below preserves correctness at the cost of atomicity. */
export async function atomicWrite(
  ctx: Pick<Context, 'fs' | 'proc'>,
  path: string,
  content: string,
): Promise<void> {
  atomicWriteCounter = (atomicWriteCounter + 1) & 0xffffffff
  const tmp = `${path}.${ctx.proc.pid()}.${atomicWriteCounter}.tmp`
  await ctx.fs.writeFile(tmp, content)
  try {
    await ctx.fs.rename(tmp, path)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'EXDEV') {
      // Cross-device rename. Fall back to writeFile + unlink — loses
      // atomicity but at least the file lands. Operators putting the
      // state root on a different fs from tmp should pick a tmp dir
      // on the same fs; this fallback is just a safety net.
      await ctx.fs.writeFile(path, content)
      try {
        await ctx.fs.unlink(tmp)
      } catch {
        /* already gone or never created */
      }
      return
    }
    throw e
  }
}

/** Regex matching the tmp filename pattern produced by {@link atomicWrite}:
 *  `<destination>.<pid>.<counter>.tmp`. Used by orphan-tmp cleanup to
 *  recover the writer's pid. */
const TMP_FILE_RE = /\.(\d+)\.\d+\.tmp$/

/** Scan a directory for orphaned `*.tmp` files left behind when a peer's
 *  bun was killed mid-atomicWrite. Files whose embedded writer-pid is
 *  no longer alive are unlinked. Returns the number unlinked. */
export async function cleanupOrphanTmpFiles(
  ctx: Pick<Context, 'fs' | 'proc'>,
  dir: string,
): Promise<number> {
  let entries: string[]
  try {
    entries = await ctx.fs.readdir(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of entries) {
    const m = TMP_FILE_RE.exec(name)
    if (!m) continue
    const pidStr = m[1]
    if (!pidStr) continue
    const pid = Number.parseInt(pidStr, 10)
    if (!Number.isFinite(pid)) continue
    if (pid === ctx.proc.pid()) continue
    if (await ctx.proc.pidAlive(pid)) continue
    try {
      await ctx.fs.unlink(`${dir}/${name}`)
      removed++
    } catch {
      /* raced with another janitor, or fs error — skip */
    }
  }
  return removed
}

/** Snapshot the size of `jsonl` (0 on ENOENT). Callers capture this
 *  BEFORE issuing the push so the subsequent delta scan can't miss a
 *  msg_id that CC writes during/before the push's resolution. */
export async function jsonlSize(ctx: Pick<Context, 'fs'>, jsonl: string | null): Promise<number> {
  if (!jsonl) return 0
  try {
    return (await ctx.fs.stat(jsonl)).size
  } catch {
    return 0
  }
}

/** Poll an own-CC JSONL for a substring match on msg_id starting from a
 *  pre-captured `startSize`. Uses an append-only window so an older
 *  record that happens to embed the msg_id literal cannot false-positive.
 *  Returns true on first match within `timeoutMs`. */
export async function verifyJsonlReceipt(
  ctx: Pick<Context, 'fs' | 'clock'>,
  jsonl: string | null,
  msgId: string,
  startSize: number,
  timeoutMs: number,
): Promise<boolean> {
  if (!msgId) return false
  if (!jsonl) return true
  const deadline = ctx.clock.nowMs() + timeoutMs
  let cursor = startSize
  while (ctx.clock.nowMs() < deadline) {
    try {
      const s = await ctx.fs.stat(jsonl)
      if (s.size > cursor) {
        // Read only the delta bytes since the last poll. Reading the
        // whole file each tick would be O(file size × poll count) per
        // delivery — on a 2MB JSONL × 20 polls, 40MB of useless traffic.
        const delta = await ctx.fs.readBytesFromOffset(jsonl, cursor, s.size - cursor)
        if (delta.includes(msgId)) return true
        cursor = s.size
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
  if (!(fromSession && msgId)) return 'skipped'
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
