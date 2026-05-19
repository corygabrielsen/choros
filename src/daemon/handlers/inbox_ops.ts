import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { asObject, cachedSenderName, isRpcError, requireString } from '#choros/daemon/helpers.ts'
import { deliverOrBuffer } from '#choros/daemon/notify.ts'
import { ERR_NOT_AUTHORIZED, ERR_NOT_FOUND, type RpcError } from '#choros/protocol/methods.ts'
import { NOTIFY_ACK, NOTIFY_READ_RECEIPT } from '#choros/protocol/notifications.ts'

/** Inbox-side ops the shim calls AFTER the daemon has pushed an
 *  inbound message into CC: confirm delivery (write delivered_at +
 *  notify the sender), and mark a message as read (archive +
 *  notify the sender). */

export interface ConfirmDeliveryResult {
  acknowledged: true
}

export function handleConfirmDelivery(
  ctx: HandlerCtx,
  rawArgs: unknown,
): ConfirmDeliveryResult | RpcError {
  const obj = asObject(rawArgs, 'confirm_delivery')
  if (isRpcError(obj)) return obj
  const session_id = requireString(obj, 'session_id', 'confirm_delivery')
  if (isRpcError(session_id)) return session_id
  const msg_id = requireString(obj, 'msg_id', 'confirm_delivery')
  if (isRpcError(msg_id)) return msg_id

  // Distinguish "row doesn't exist" from "not your message" from
  // "already delivered" so callers can act on the answer rather than
  // see an opaque acknowledged:true for every state.
  const row = ctx.storage.db
    .query('SELECT to_session, delivered_at FROM messages WHERE id = ?')
    .get(msg_id) as { to_session: string; delivered_at: string | null } | null
  if (!row) return { code: ERR_NOT_FOUND, message: `confirm_delivery: unknown msg_id` }
  if (row.to_session !== session_id) {
    return { code: ERR_NOT_AUTHORIZED, message: 'confirm_delivery: not your message' }
  }
  if (row.delivered_at !== null) return { acknowledged: true } // idempotent

  const result = ctx.storage.db
    .query(
      `UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL
       RETURNING from_session`,
    )
    .get(ctx.nowIso(), msg_id) as { from_session: string } | null
  if (!result) return { acknowledged: true }

  deliverOrBuffer(ctx, result.from_session, NOTIFY_ACK, {
    msg_id,
    status: 'delivered',
    to_session: session_id,
    verified_at: ctx.nowIso(),
  })
  return { acknowledged: true }
}

export interface MarkReadResult {
  acknowledged: true
}

export function handleMarkRead(ctx: HandlerCtx, rawArgs: unknown): MarkReadResult | RpcError {
  const obj = asObject(rawArgs, 'mark_read')
  if (isRpcError(obj)) return obj
  const session_id = requireString(obj, 'session_id', 'mark_read')
  if (isRpcError(session_id)) return session_id
  const msg_id = requireString(obj, 'msg_id', 'mark_read')
  if (isRpcError(msg_id)) return msg_id

  const row = ctx.storage.db
    .query('SELECT to_session, read_at FROM messages WHERE id = ?')
    .get(msg_id) as { to_session: string; read_at: string | null } | null
  if (!row) return { code: ERR_NOT_FOUND, message: 'mark_read: unknown msg_id' }
  if (row.to_session !== session_id) {
    return { code: ERR_NOT_AUTHORIZED, message: 'mark_read: not your message' }
  }
  if (row.read_at !== null) return { acknowledged: true } // idempotent

  const result = ctx.storage.db
    .query(
      `UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL
       RETURNING from_session`,
    )
    .get(ctx.nowIso(), msg_id) as { from_session: string } | null
  if (!result) return { acknowledged: true }

  const readerName = cachedSenderName(ctx, session_id)

  deliverOrBuffer(ctx, result.from_session, NOTIFY_READ_RECEIPT, {
    msg_id,
    by_session: session_id,
    by_name: readerName,
    read_at: ctx.nowIso(),
  })
  return { acknowledged: true }
}
