import { join } from 'node:path'
import type { AskRegistry } from './ask-registry.ts'
import {
  JSONL_VERIFY_TIMEOUT_MS,
  type WedgeState,
  pushChannelNotification,
  verifyJsonlReceipt,
  writeAckToSender,
} from './delivery.ts'
import type { Context } from './effects.ts'
import { findJsonlForSession } from './identity.ts'

/** Maximum UTF-8 body size for any outbound message, enforced at every
 *  outbound tool boundary. Blob overflow is intentionally not handled —
 *  callers split or trim large content themselves. */
export const BODY_CAP_BYTES = 64 * 1024

/** Cadence for the periodic re-emit sweep. inotify fires once per file
 *  change; the sweep retries inbox files whose initial push timed out. */
export const SWEEP_INTERVAL_MS = 60_000
/** Cap on the dropped-ack dedup Set. Older entries fall off so a long-
 *  running bun under sustained wedge doesn't grow memory unboundedly.
 *  We use insertion-order Set semantics; on overflow, drop the oldest. */
export const DROPPED_ACK_DEDUP_CAP = 1024

/**
 * Coerce an arbitrary value to a string field, rejecting non-string types.
 *
 * @remarks
 * Used at trust boundaries where attacker-controllable input flows into
 * metadata or filesystem paths. Without this, `String(value ?? '')` would
 * silently turn `{}` into `"[object Object]"` and corrupt routing — see
 * the type-coercion bug-hunt finding.
 *
 * @param value - The candidate.
 * @param label - Diagnostic label for error messages.
 * @returns Empty string when `value` is null/undefined; the string when
 *   it's a string; throws otherwise.
 */
export function asStringField(value: unknown, label: string): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  throw new Error(`${label}: expected string, got ${typeof value}`)
}

/** Speech-act taxonomy. Optional `act` field on every outbound message.
 *  Borrowed from speech-act theory in linguistics — the type of utterance
 *  carries semantic content distinct from the body. Recipients can route
 *  attention based on it (answer QUESTIONs first, defer ANNOUNCEments). */
export const SPEECH_ACTS = [
  'REQUEST',
  'COMMIT',
  'ANNOUNCE',
  'QUESTION',
  'ANSWER',
  'OBSERVATION',
] as const
/** Union of valid {@link SPEECH_ACTS} values. */
export type SpeechAct = (typeof SPEECH_ACTS)[number]

/**
 * Validate an optional speech-act tag.
 *
 * @returns The act when valid, `undefined` when omitted.
 * @throws When `value` is non-string or not a member of {@link SPEECH_ACTS}.
 */
export function validateSpeechAct(value: unknown): SpeechAct | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('act must be a string')
  if (!(SPEECH_ACTS as readonly string[]).includes(value)) {
    throw new Error(`act must be one of: ${SPEECH_ACTS.join(', ')}`)
  }
  return value as SpeechAct
}

/** Paths + identity needed to process a single inbox file. Passed to
 *  every emit/archive operation so the module stays free of module-level
 *  state. */
export interface InboxTargets {
  stateRoot: string
  projectsRoot: string
  me: string
  myName: string
  wedgePath: string
  inboxDir: string
  readDir: string
}

/**
 * On-disk + on-wire shape of a choros message. Optional fields are
 * populated only when meaningful for that message variant (broadcast,
 * topic publish, thread post, reply).
 */
export interface InboxMessage {
  id: string
  ts?: string
  from_session?: string
  from_name?: string
  from_host?: string
  from_cwd?: string
  body?: string
  in_reply_to?: string
  thread_id?: string
  topic?: string
  broadcast?: boolean
  mentions?: string[]
  act?: SpeechAct
}

/** Read a single inbox `.json`. Returns null on missing or unparseable. */
export async function readInboxMessage(
  ctx: Pick<Context, 'fs' | 'proc'>,
  filePath: string,
): Promise<InboxMessage | null> {
  let raw: string
  try {
    raw = await ctx.fs.readFile(filePath)
  } catch {
    return null
  }
  try {
    return JSON.parse(raw) as InboxMessage
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    ctx.proc.stderr(`[choros] failed to parse ${filePath}: ${m}\n`)
    return null
  }
}

/** Outcome of an {@link emitInboxMessage} call.
 *
 *  - `emitted`: pushed AND JSONL-confirmed; `.seen` sidecar + `.ack` written.
 *  - `skipped`: filename ineligible (wrong extension, already seen, etc).
 *  - `timeout`: push timed out; file left for next sweep.
 *  - `dropped`: push resolved but JSONL probe missed; `.dropped` written. */
export interface EmitResult {
  status: 'emitted' | 'skipped' | 'timeout' | 'dropped'
}

/** Try to emit an inbox message as a channel event to OWN agent. On
 *  notification timeout or JSONL probe miss, leave the `.json` on disk
 *  (no `.seen` sidecar) so the next sweep retries. On JSONL miss, also
 *  write a `.dropped` ack to the sender (dedup'd via emittedDroppedAcks
 *  so the same un-deliverable msg_id doesn't spam the sender). */
export async function emitInboxMessage(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc' | 'env' | 'mcp'>,
  targets: InboxTargets,
  wedgeState: WedgeState,
  emittedDroppedAcks: Set<string>,
  inFlight: Set<string>,
  filename: string,
  askRegistry?: AskRegistry,
): Promise<EmitResult> {
  if (!filename.endsWith('.json')) return { status: 'skipped' }
  if (filename.startsWith('.')) return { status: 'skipped' }
  if (filename.endsWith('.seen')) return { status: 'skipped' }
  // Re-entry guard: inotify can fire twice on the same file (close_write +
  // moved_to); a periodic sweep can race the watcher. Two concurrent emits
  // for the same filename would double-fire the channel push. Guard at the
  // filename granularity (not msg_id — file may not be parseable yet).
  if (inFlight.has(filename)) return { status: 'skipped' }
  const src = join(targets.inboxDir, filename)
  const sidecar = `${src}.seen`
  const archived = join(targets.readDir, filename)
  if (ctx.fs.existsSync(sidecar)) return { status: 'skipped' }
  if (ctx.fs.existsSync(archived)) return { status: 'skipped' }
  if (!ctx.fs.existsSync(src)) return { status: 'skipped' }

  inFlight.add(filename)
  try {
    return await emitInboxMessageInner(
      ctx,
      targets,
      wedgeState,
      emittedDroppedAcks,
      filename,
      src,
      sidecar,
      askRegistry,
    )
  } finally {
    inFlight.delete(filename)
  }
}

async function emitInboxMessageInner(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc' | 'env' | 'mcp'>,
  targets: InboxTargets,
  wedgeState: WedgeState,
  emittedDroppedAcks: Set<string>,
  filename: string,
  src: string,
  sidecar: string,
  askRegistry?: AskRegistry,
): Promise<EmitResult> {
  const data = await readInboxMessage(ctx, src)
  if (!data) return { status: 'skipped' }
  if (askRegistry) askRegistry.notifyIfWaiting(data)
  void filename
  // Stringify only fields known to be string-shaped. Non-string fields
  // are not coerced (would yield "[object Object]" and corrupt meta);
  // they are dropped from the meta entirely.
  const safeString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  const msgId = safeString(data.id) ?? ''
  const meta: Record<string, string> = {
    source: 'choros',
    msg_id: msgId,
    ts: safeString(data.ts) ?? '',
    from_session: safeString(data.from_session) ?? '',
    from_name: safeString(data.from_name) ?? 'unknown',
    from_host: safeString(data.from_host) ?? '',
    from_cwd: safeString(data.from_cwd) ?? '',
  }
  const irt = safeString(data.in_reply_to)
  if (irt) meta.in_reply_to = irt
  const tid = safeString(data.thread_id)
  if (tid) meta.thread_id = tid
  const top = safeString(data.topic)
  if (top) meta.topic = top
  if (data.broadcast) meta.broadcast = 'true'
  if (data.act) meta.act = data.act
  if (Array.isArray(data.mentions) && data.mentions.length > 0) {
    const mentionedMe = data.mentions.some(
      m => m === targets.me || (typeof m === 'string' && m === targets.myName),
    )
    if (mentionedMe) meta.mentioned_me = 'true'
    meta.mentions = data.mentions.join(',')
  }

  const push = await pushChannelNotification(
    ctx,
    wedgeState,
    targets.wedgePath,
    msgId,
    String(data.body ?? ''),
    meta,
  )
  if (push !== 'ok') return { status: 'timeout' }

  const jsonl = await findJsonlForSession(ctx, targets.projectsRoot, targets.me)
  const verified = await verifyJsonlReceipt(ctx, jsonl, msgId, JSONL_VERIFY_TIMEOUT_MS)
  if (!verified) {
    ctx.proc.stderr(
      `[choros] push resolved but msg_id=${msgId} NOT in own JSONL — withholding .seen; sweep retries.\n`,
    )
    if (!emittedDroppedAcks.has(msgId)) {
      emittedDroppedAcks.add(msgId)
      // Bound the dedup set so a long-running bun under sustained wedge
      // doesn't grow memory unboundedly. Drop the oldest entry. Worst
      // case on overflow: a long-dead msg's dropped-ack re-fires once,
      // which is acceptable noise vs. an unbounded leak.
      while (emittedDroppedAcks.size > DROPPED_ACK_DEDUP_CAP) {
        const oldest = emittedDroppedAcks.values().next().value
        if (oldest !== undefined) emittedDroppedAcks.delete(oldest)
      }
      try {
        await writeAckToSender(
          ctx,
          { stateRoot: targets.stateRoot, me: targets.me, myName: targets.myName },
          data,
          'dropped',
          ctx.proc.pid(),
        )
      } catch (e: unknown) {
        const m = e instanceof Error ? e.message : String(e)
        ctx.proc.stderr(`[choros] .dropped ack write failed: ${m}\n`)
      }
    }
    return { status: 'dropped' }
  }
  emittedDroppedAcks.delete(msgId)
  const marker = JSON.stringify({
    pushed_at: ctx.clock.nowIso(),
    verified_at: ctx.clock.nowIso(),
    pid: ctx.proc.pid(),
  })
  try {
    await ctx.fs.writeFile(sidecar, marker)
  } catch (e: unknown) {
    // If we can't write .seen, the next sweep will re-emit the message.
    // Surface the failure so it's visible — otherwise an unwritable inbox
    // dir would loop silently. The msg push already happened, so the
    // recipient saw it; only the sender's verify_path stat lies until
    // the underlying fs problem is resolved.
    const m = e instanceof Error ? e.message : String(e)
    ctx.proc.stderr(`[choros] .seen sidecar write failed for ${sidecar}: ${m}\n`)
  }
  try {
    await writeAckToSender(
      ctx,
      { stateRoot: targets.stateRoot, me: targets.me, myName: targets.myName },
      data,
      'delivered',
      ctx.proc.pid(),
    )
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e)
    ctx.proc.stderr(`[choros] .ack write failed: ${m}\n`)
  }
  return { status: 'emitted' }
}

/** Move an inbox `.json` into `read/` and remove its `.seen` sidecar.
 *  Returns the archived path. Used by /choros read and by the read-
 *  receipt emitter (which fires a channel event to the original sender). */
export async function archiveInboxMessage(
  ctx: Pick<Context, 'fs'>,
  targets: Pick<InboxTargets, 'inboxDir' | 'readDir'>,
  filename: string,
): Promise<string> {
  const src = join(targets.inboxDir, filename)
  const dst = join(targets.readDir, filename)
  await ctx.fs.mkdir(targets.readDir, { recursive: true })
  await ctx.fs.rename(src, dst)
  try {
    await ctx.fs.unlink(`${src}.seen`)
  } catch {
    /* already gone */
  }
  return dst
}

/** Enforce the body cap on outbound (send / broadcast / publish). */
export function enforceBodyCap(body: string, label: string): void {
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > BODY_CAP_BYTES) {
    throw new Error(`${label}: body exceeds ${BODY_CAP_BYTES} bytes (${bytes})`)
  }
}
