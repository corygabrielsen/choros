import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { asObject, isRpcError, requireString } from '#choros/daemon/helpers.ts'
import { deliverOrBuffer } from '#choros/daemon/notify.ts'
import type { RpcError } from '#choros/protocol/methods.ts'
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

  const result = ctx.storage.db
    .query(
      `UPDATE messages SET delivered_at = ?
       WHERE id = ? AND to_session = ? AND delivered_at IS NULL
       RETURNING from_session`,
    )
    .get(ctx.nowIso(), msg_id, session_id) as { from_session: string } | null
  if (!result) return { acknowledged: true } // idempotent

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

  const result = ctx.storage.db
    .query(
      `UPDATE messages SET read_at = ?
       WHERE id = ? AND to_session = ? AND read_at IS NULL
       RETURNING from_session`,
    )
    .get(ctx.nowIso(), msg_id, session_id) as { from_session: string } | null
  if (!result) return { acknowledged: true }

  const readerName =
    (
      ctx.storage.db.query('SELECT display_name FROM sessions WHERE id = ?').get(session_id) as {
        display_name: string | null
      } | null
    )?.display_name ?? null

  deliverOrBuffer(ctx, result.from_session, NOTIFY_READ_RECEIPT, {
    msg_id,
    by_session: session_id,
    by_name: readerName,
    read_at: ctx.nowIso(),
  })
  return { acknowledged: true }
}
