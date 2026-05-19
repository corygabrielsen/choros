import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { enqueuePendingNotification } from '#choros/daemon/storage.ts'

/** Schedule a notification for delivery to `sessionId`'s shim. If the
 *  shim is currently connected, the notification is written
 *  immediately to its socket; otherwise (or if the socket write fails
 *  during a half-closed-connection window) it lands in the
 *  `pending_notifications` table and the shim drains it on its next
 *  `choros.register` handshake. */
export function deliverOrBuffer(
  ctx: HandlerCtx,
  sessionId: string,
  method: string,
  params: unknown,
): void {
  const sink = ctx.router.sinkFor(sessionId)
  if (sink) {
    const frame = JSON.stringify({ jsonrpc: '2.0', method, params })
    if (sink.write(frame)) return
    // Sink reported failure (socket gone between our isOpen() check
    // and write). Fall through and enqueue so the notification isn't
    // silently dropped — the shim will drain it on next register.
    ctx.router.unbindBySink(sink)
  }
  enqueuePendingNotification(ctx.storage, {
    session_id: sessionId,
    method,
    params,
    nowIso: ctx.nowIso(),
  })
}
