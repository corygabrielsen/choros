import { join } from 'node:path'
import {
  JSONL_VERIFY_TIMEOUT_MS,
  type WedgeState,
  pushChannelNotification,
  verifyJsonlReceipt,
  writeAckToSender,
} from './delivery.ts'
import type { Context } from './effects.ts'
import { findJsonlForSession } from './identity.ts'

export const BODY_CAP_BYTES = 64 * 1024
export const SWEEP_INTERVAL_MS = 60_000

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
export type SpeechAct = (typeof SPEECH_ACTS)[number]

export function validateSpeechAct(value: unknown): SpeechAct | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('act must be a string')
  if (!(SPEECH_ACTS as readonly string[]).includes(value)) {
    throw new Error(`act must be one of: ${SPEECH_ACTS.join(', ')}`)
  }
  return value as SpeechAct
}

export interface InboxTargets {
  stateRoot: string
  projectsRoot: string
  me: string
  myName: string
  wedgePath: string
  inboxDir: string
  readDir: string
}

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
  filename: string,
): Promise<EmitResult> {
  if (!filename.endsWith('.json')) return { status: 'skipped' }
  if (filename.startsWith('.')) return { status: 'skipped' }
  if (filename.endsWith('.seen')) return { status: 'skipped' }
  const src = join(targets.inboxDir, filename)
  const sidecar = `${src}.seen`
  const archived = join(targets.readDir, filename)
  if (ctx.fs.existsSync(sidecar)) return { status: 'skipped' }
  if (ctx.fs.existsSync(archived)) return { status: 'skipped' }
  if (!ctx.fs.existsSync(src)) return { status: 'skipped' }

  const data = await readInboxMessage(ctx, src)
  if (!data) return { status: 'skipped' }
  const msgId = String(data.id ?? '')
  const meta: Record<string, string> = {
    source: 'choros',
    msg_id: msgId,
    ts: String(data.ts ?? ''),
    from_session: String(data.from_session ?? ''),
    from_name: String(data.from_name ?? 'unknown'),
    from_host: String(data.from_host ?? ''),
    from_cwd: String(data.from_cwd ?? ''),
  }
  if (data.in_reply_to) meta.in_reply_to = String(data.in_reply_to)
  if (data.thread_id) meta.thread_id = String(data.thread_id)
  if (data.topic) meta.topic = String(data.topic)
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
  await ctx.fs.writeFile(sidecar, marker)
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
