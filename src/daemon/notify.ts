import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { enqueuePendingNotification } from '#choros/daemon/storage.ts'
import { NOTIFY_PRESENCE } from '#choros/protocol/notifications.ts'

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
  try {
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
  } catch (e: unknown) {
    // Catch + log rather than throw. A throwing deliverOrBuffer in
    // the middle of a fan-out loop would strand every later
    // recipient — the broadcast row is already committed, half the
    // peers would never hear about it. Logged here so an operator
    // can correlate dropped notifications with the row.
    const m = e instanceof Error ? e.message : String(e)
    process.stderr.write(
      `[choros-daemon] deliverOrBuffer dropped notification to ${sessionId} (${method}): ${m}\n`,
    )
  }
}

/** Fan out a join/leave presence event to every currently-connected
 *  peer (excluding the subject). Push-only — presence is ephemeral, so
 *  unlike deliverOrBuffer it does NOT enqueue for offline sessions (a
 *  "joined" replayed minutes later on reconnect is noise). */
export function broadcastPresence(
  ctx: HandlerCtx,
  event: 'join' | 'leave',
  sessionId: string,
  displayName: string | null,
): void {
  const ts = ctx.nowIso()
  const who = displayName ?? sessionId.slice(0, 8)
  const body = `${who} ${event === 'join' ? 'joined' : 'left'}`
  for (const peerId of ctx.router.connectedSessionIds()) {
    if (peerId === sessionId) continue
    const sink = ctx.router.sinkFor(peerId)
    if (!sink) continue
    try {
      sink.write(
        JSON.stringify({
          jsonrpc: '2.0',
          method: NOTIFY_PRESENCE,
          params: { event, session_id: sessionId, display_name: displayName, body, ts },
        }),
      )
    } catch {
      /* a dead peer sink is harmless here — presence is best-effort */
    }
  }
}
