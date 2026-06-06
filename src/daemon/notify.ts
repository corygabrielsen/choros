import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { enqueuePendingNotification } from '#choros/daemon/storage.ts'
import { NOTIFY_DAEMON, NOTIFY_PRESENCE } from '#choros/protocol/notifications.ts'

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

/** Last-writer-wins: clear `display_name` on every session other than
 *  `claimingSessionId` that currently holds `name` (case-insensitive),
 *  drop their router cache entries, and broadcast a synthetic rename
 *  (name → null) so live peers update without waiting for a doctor or
 *  the next leave/join cycle. Without this, two sessions can coexist
 *  with the same display name and `resolveRecipient`'s tier-3 fallback
 *  silently routes by-name traffic to whichever wrote heartbeat_at most
 *  recently. */
export function evictDisplayNameHolders(
  ctx: HandlerCtx,
  name: string,
  claimingSessionId: string,
): void {
  const evicted = ctx.storage.db
    .query(
      `SELECT id FROM sessions
       WHERE display_name = ? COLLATE NOCASE AND id != ?`,
    )
    .all(name, claimingSessionId) as { id: string }[]
  if (evicted.length === 0) return
  ctx.storage.db
    .query(
      `UPDATE sessions SET display_name = NULL
       WHERE display_name = ? COLLATE NOCASE AND id != ?`,
    )
    .run(name, claimingSessionId)
  for (const e of evicted) {
    ctx.router.setDisplayName(e.id, null)
    broadcastPresence(ctx, 'rename', e.id, null, name)
  }
}

/** Announce a daemon-lifecycle transition to every currently-connected
 *  peer. Push-only and best-effort — no buffering, no retry; called
 *  during shutdown when there is no opportunity to drain anything.
 *  The shim re-emits as a `choros.daemon` channel event so the CC can
 *  frame the burst of disconnect/rejoin notifications that follows.
 *  Caller supplies `body` (one-line human prose) and the meta payload. */
export function broadcastDaemonLifecycle(
  ctx: HandlerCtx,
  event: 'shutting_down',
  body: string,
): void {
  const params = {
    event,
    body,
    ts: ctx.nowIso(),
    daemon_version: ctx.daemon.version,
    daemon_started_at: ctx.daemon.startedAt,
  }
  const frame = JSON.stringify({ jsonrpc: '2.0', method: NOTIFY_DAEMON, params })
  for (const peerId of ctx.router.connectedSessionIds()) {
    const sink = ctx.router.sinkFor(peerId)
    if (!sink) continue
    try {
      sink.write(frame)
    } catch {
      /* sinks dying during shutdown is expected — no recovery here */
    }
  }
}

/** Fan out a join/leave/rename presence event to every currently-connected
 *  peer (excluding the subject). Push-only — presence is ephemeral, so
 *  unlike deliverOrBuffer it does NOT enqueue for offline sessions (a
 *  "joined" replayed minutes later on reconnect is noise). For `rename`,
 *  pass the prior name as `oldName` so peers can correlate the identity. */
export function broadcastPresence(
  ctx: HandlerCtx,
  event: 'join' | 'leave' | 'rename',
  sessionId: string,
  displayName: string | null,
  oldName?: string | null,
): void {
  const ts = ctx.nowIso()
  const who = displayName ?? sessionId.slice(0, 8)
  const body =
    event === 'rename'
      ? `${oldName ?? sessionId.slice(0, 8)} renamed to ${who}`
      : `${who} ${event === 'join' ? 'joined' : 'left'}`
  const params: Record<string, unknown> = {
    event,
    session_id: sessionId,
    display_name: displayName,
    body,
    ts,
  }
  if (event === 'rename') params.old_name = oldName ?? null
  for (const peerId of ctx.router.connectedSessionIds()) {
    if (peerId === sessionId) continue
    const sink = ctx.router.sinkFor(peerId)
    if (!sink) continue
    try {
      sink.write(JSON.stringify({ jsonrpc: '2.0', method: NOTIFY_PRESENCE, params }))
    } catch {
      /* a dead peer sink is harmless here — presence is best-effort */
    }
  }
}
