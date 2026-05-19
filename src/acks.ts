import { join } from 'node:path'
import { PUSH_TIMEOUT_MS, withTimeout } from './delivery.ts'
import type { Context } from './effects.ts'

/**
 * Emit a delivery / read / reaction ack file as a channel event to OUR agent.
 *
 * @remarks
 * When a peer's bun JSONL-confirms (or fails to confirm) delivery of a message
 * we sent, it writes a `.ack` / `.dropped` file into our `sent_acks/` dir.
 * Reactions land as `.react` files; read receipts as `.read`. This function
 * parses one such file and pushes a corresponding `choros-ack` /
 * `choros-reaction` / `choros-read` channel notification, then unlinks the
 * file on success. On push timeout the file is left on disk so a later sweep
 * (or restart pre-scan) can retry.
 *
 * @param ctx - Effects context.
 * @param myAcksDir - Absolute path to our own `sent_acks/` directory.
 * @param filename - Just the filename within `myAcksDir`; not a full path.
 * @returns The outcome of the push attempt.
 */
export async function emitAck(
  ctx: Pick<Context, 'fs' | 'mcp' | 'clock' | 'proc'>,
  myAcksDir: string,
  filename: string,
): Promise<'emitted' | 'skipped' | 'timeout'> {
  if (filename.startsWith('.')) return 'skipped'
  const isAck = filename.endsWith('.ack') || filename.endsWith('.dropped')
  const isReact = filename.endsWith('.react')
  const isRead = filename.endsWith('.read')
  if (!isAck && !isReact && !isRead) return 'skipped'
  const path = join(myAcksDir, filename)
  let raw: string
  try {
    raw = await ctx.fs.readFile(path)
  } catch {
    return 'skipped'
  }
  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw) as Record<string, unknown>
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e)
    ctx.proc.stderr(`[choros] failed to parse ack ${path}: ${m}\n`)
    return 'skipped'
  }

  let meta: Record<string, string>
  let content: string
  if (isReact) {
    meta = {
      source: 'choros-reaction',
      msg_id: String(data.msg_id ?? ''),
      emoji: String(data.emoji ?? ''),
      from_session: String(data.from_session ?? ''),
      from_name: String(data.from_name ?? ''),
      ts: String(data.ts ?? ''),
    }
    const reactor =
      data.from_name || (data.from_session ? String(data.from_session).slice(0, 8) : 'unknown')
    content = `${reactor} reacted ${data.emoji} to msg_id=${data.msg_id}`
  } else if (isRead) {
    meta = {
      source: 'choros-read',
      msg_id: String(data.msg_id ?? ''),
      by_session: String(data.by_session ?? ''),
      by_name: String(data.by_name ?? ''),
      read_at: String(data.read_at ?? ''),
    }
    const reader =
      data.by_name || (data.by_session ? String(data.by_session).slice(0, 8) : 'unknown')
    content = `${reader} read msg_id=${data.msg_id}`
  } else {
    meta = {
      source: 'choros-ack',
      msg_id: String(data.msg_id ?? ''),
      status: String(data.status ?? ''),
      to_session: String(data.to_session ?? ''),
      to_name: String(data.to_name ?? ''),
      verified_at: String(data.verified_at ?? ''),
    }
    const recipient = data.to_name || data.to_session
    content =
      data.status === 'delivered'
        ? `Delivered to ${recipient}: msg_id=${data.msg_id}`
        : `Dropped — recipient bun could not confirm receipt at ${recipient}: msg_id=${data.msg_id}`
  }

  const result = await withTimeout(
    ctx,
    ctx.mcp.notify('notifications/claude/channel', { content, meta }),
    PUSH_TIMEOUT_MS,
    `ack ${filename}`,
  )
  if (result === 'ok') {
    try {
      await ctx.fs.unlink(path)
    } catch {
      /* already gone */
    }
    return 'emitted'
  }
  return 'timeout'
}
