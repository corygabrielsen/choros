import { LIVE_MAX_AGE_MS } from '#choros/constants.ts'
import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import {
  asObject,
  isRpcError,
  nowMsFromCtx,
  optionalString,
  requireString,
} from '#choros/daemon/helpers.ts'
import { deliverOrBuffer } from '#choros/daemon/notify.ts'
import { generateMessageId } from '#choros/identity.ts'
import { enforceBodyCap, validateSpeechAct } from '#choros/inbox.ts'
import { ERR_INVALID_PARAMS, type RpcError } from '#choros/protocol/methods.ts'
import { NOTIFY_INBOUND_MESSAGE } from '#choros/protocol/notifications.ts'

export interface BroadcastResult {
  msg_id: string
  recipients: string[]
}

export function handleBroadcast(ctx: HandlerCtx, rawArgs: unknown): BroadcastResult | RpcError {
  const obj = asObject(rawArgs, 'broadcast')
  if (isRpcError(obj)) return obj

  const session_id = requireString(obj, 'session_id', 'broadcast')
  if (isRpcError(session_id)) return session_id
  const body = requireString(obj, 'body', 'broadcast')
  if (isRpcError(body)) return body
  try {
    enforceBodyCap(body, 'broadcast')
  } catch (e: unknown) {
    return { code: ERR_INVALID_PARAMS, message: e instanceof Error ? e.message : String(e) }
  }

  const actRaw = optionalString(obj, 'act', 'broadcast')
  if (isRpcError(actRaw)) return actRaw
  let act: string | undefined
  try {
    act = validateSpeechAct(actRaw)
  } catch (e: unknown) {
    return { code: ERR_INVALID_PARAMS, message: e instanceof Error ? e.message : String(e) }
  }

  const now = nowMsFromCtx(ctx)
  const liveCutoff = new Date(now - LIVE_MAX_AGE_MS).toISOString()
  const livePeers = ctx.storage.db
    .query(
      `SELECT id, display_name FROM sessions
       WHERE id != ? AND lock_pid IS NOT NULL AND heartbeat_at >= ?`,
    )
    .all(session_id, liveCutoff) as { id: string; display_name: string | null }[]

  const msgId = generateMessageId(session_id, ctx.nowIso())
  const senderName =
    (
      ctx.storage.db.query('SELECT display_name FROM sessions WHERE id = ?').get(session_id) as {
        display_name: string | null
      } | null
    )?.display_name ?? null

  ctx.storage.db.transaction(() => {
    const insert = ctx.storage.db.query(
      `INSERT INTO messages (id, from_session, to_session, body, act, broadcast, ts)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    )
    for (const peer of livePeers) {
      // Each recipient gets its own row (mirrors the per-recipient
      // inbox file from the v0 model). The msg_id is the same but
      // the to_session differs — PK conflict is avoided by suffixing
      // with the full recipient id (8-char prefix collides when peers
      // share a UUID prefix, which is common in test fixtures).
      const perPeerId = `${msgId}-${peer.id}`
      insert.run(perPeerId, session_id, peer.id, body, act ?? null, ctx.nowIso())
      deliverOrBuffer(ctx, peer.id, NOTIFY_INBOUND_MESSAGE, {
        msg_id: perPeerId,
        from_session: session_id,
        from_name: senderName,
        to_session: peer.id,
        body,
        ts: ctx.nowIso(),
        broadcast: true,
        ...(act ? { act } : {}),
      })
    }
  })()

  return { msg_id: msgId, recipients: livePeers.map(p => p.id) }
}
