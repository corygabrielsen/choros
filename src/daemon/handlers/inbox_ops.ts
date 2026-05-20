import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { asObject, cachedSenderName, isRpcError, requireString } from '#choros/daemon/helpers.ts'
import { deliverOrBuffer } from '#choros/daemon/notify.ts'
import { ERR_NOT_AUTHORIZED, ERR_NOT_FOUND, type RpcError } from '#choros/protocol/methods.ts'
import { NOTIFY_ACK, NOTIFY_READ_RECEIPT } from '#choros/protocol/notifications.ts'

/** Inbox-side ops the shim calls AFTER attempting to push an inbound
 *  message into CC: confirm delivery once the msg_id is verified in the
 *  recipient's transcript (write delivered_at + ack the sender), report a
 *  silent drop when it never surfaced (write dropped_at + ack dropped +
 *  wedge after repeated drops), and mark a message read (archive + notify
 *  the sender). */

/** Consecutive verified drops before a session is marked wedged. One drop
 *  can be a transient race; a run of them means the push channel to that
 *  CC is reliably losing messages. */
const WEDGE_DROP_THRESHOLD = 3

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

  // A verified delivery proves the push channel works again: reset the
  // consecutive-drop counter and clear any wedge so doctor/send stop
  // reporting this session as dropping.
  ctx.router.clearDrops(session_id)
  ctx.storage.db.query('UPDATE sessions SET wedged_at = NULL WHERE id = ?').run(session_id)
  return { acknowledged: true }
}

export interface ReportDropResult {
  acknowledged: true
}

/** The shim calls this when a pushed inbound message never surfaced in the
 *  recipient's transcript within the verification window (or the push
 *  itself timed out). Records dropped_at, acks the sender with
 *  status='dropped' so it knows the message did NOT land, and wedges the
 *  session after {@link WEDGE_DROP_THRESHOLD} consecutive drops. */
export function handleReportDrop(ctx: HandlerCtx, rawArgs: unknown): ReportDropResult | RpcError {
  const obj = asObject(rawArgs, 'report_drop')
  if (isRpcError(obj)) return obj
  const session_id = requireString(obj, 'session_id', 'report_drop')
  if (isRpcError(session_id)) return session_id
  const msg_id = requireString(obj, 'msg_id', 'report_drop')
  if (isRpcError(msg_id)) return msg_id

  const row = ctx.storage.db
    .query('SELECT to_session, delivered_at, dropped_at FROM messages WHERE id = ?')
    .get(msg_id) as {
    to_session: string
    delivered_at: string | null
    dropped_at: string | null
  } | null
  if (!row) return { code: ERR_NOT_FOUND, message: 'report_drop: unknown msg_id' }
  if (row.to_session !== session_id) {
    return { code: ERR_NOT_AUTHORIZED, message: 'report_drop: not your message' }
  }
  // A delivery already verified beats a late drop report — the transcript
  // proof wins the race against a push timeout.
  if (row.delivered_at !== null) return { acknowledged: true }
  if (row.dropped_at !== null) return { acknowledged: true } // idempotent

  const result = ctx.storage.db
    .query(
      `UPDATE messages SET dropped_at = ? WHERE id = ? AND delivered_at IS NULL AND dropped_at IS NULL
       RETURNING from_session`,
    )
    .get(ctx.nowIso(), msg_id) as { from_session: string } | null
  if (!result) return { acknowledged: true }

  deliverOrBuffer(ctx, result.from_session, NOTIFY_ACK, {
    msg_id,
    status: 'dropped',
    to_session: session_id,
    verified_at: ctx.nowIso(),
  })

  const consecutive = ctx.router.recordDrop(session_id)
  if (consecutive >= WEDGE_DROP_THRESHOLD) {
    ctx.storage.db
      .query('UPDATE sessions SET wedged_at = ? WHERE id = ? AND wedged_at IS NULL')
      .run(ctx.nowIso(), session_id)
  }
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
