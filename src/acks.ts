import { join } from 'node:path'
import { PUSH_TIMEOUT_MS, withTimeout } from './delivery.ts'
import type { Context } from './effects.ts'

type AckKind = 'react' | 'read' | 'ack'

interface AckEvent {
  content: string
  meta: Record<string, string>
}

function s(value: unknown): string {
  return typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? ''
      : String(value)
}

function buildReactionEvent(data: Record<string, unknown>): AckEvent {
  const reactor = s(data.from_name) || s(data.from_session).slice(0, 8) || 'unknown'
  return {
    content: `${reactor} reacted ${s(data.emoji)} to msg_id=${s(data.msg_id)}`,
    meta: {
      source: 'choros-reaction',
      msg_id: s(data.msg_id),
      emoji: s(data.emoji),
      from_session: s(data.from_session),
      from_name: s(data.from_name),
      ts: s(data.ts),
    },
  }
}

function buildReadEvent(data: Record<string, unknown>): AckEvent {
  const reader = s(data.by_name) || s(data.by_session).slice(0, 8) || 'unknown'
  return {
    content: `${reader} read msg_id=${s(data.msg_id)}`,
    meta: {
      source: 'choros-read',
      msg_id: s(data.msg_id),
      by_session: s(data.by_session),
      by_name: s(data.by_name),
      read_at: s(data.read_at),
    },
  }
}

function buildDeliveryEvent(data: Record<string, unknown>): AckEvent {
  const recipient = s(data.to_name) || s(data.to_session)
  const delivered = data.status === 'delivered'
  return {
    content: delivered
      ? `Delivered to ${recipient}: msg_id=${s(data.msg_id)}`
      : `Dropped — recipient bun could not confirm receipt at ${recipient}: msg_id=${s(data.msg_id)}`,
    meta: {
      source: 'choros-ack',
      msg_id: s(data.msg_id),
      status: s(data.status),
      to_session: s(data.to_session),
      to_name: s(data.to_name),
      verified_at: s(data.verified_at),
    },
  }
}

function classifyAckFilename(filename: string): AckKind | null {
  if (filename.startsWith('.')) return null
  if (filename.endsWith('.react')) return 'react'
  if (filename.endsWith('.read')) return 'read'
  if (filename.endsWith('.ack') || filename.endsWith('.dropped')) return 'ack'
  return null
}

function buildAckEvent(kind: AckKind, data: Record<string, unknown>): AckEvent {
  switch (kind) {
    case 'react':
      return buildReactionEvent(data)
    case 'read':
      return buildReadEvent(data)
    case 'ack':
      return buildDeliveryEvent(data)
  }
}

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
  const kind = classifyAckFilename(filename)
  if (kind === null) return 'skipped'
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

  const { content, meta } = buildAckEvent(kind, data)
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
