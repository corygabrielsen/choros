/**
 * In-memory session-routing table. Maps `session_id` to the currently
 * connected shim's socket so the daemon can push notifications back to
 * the right CC session. Lives only in the daemon process; the DB is
 * the durable store for everything else.
 */

/** Anything that can write a line of NDJSON. The RPC server's per-
 *  connection socket implements this; tests can pass a mock. */
export interface NotificationSink {
  write(line: string): void
  /** True iff the underlying transport is still open. The daemon
   *  checks this before each push so a half-closed socket doesn't
   *  silently drop notifications. */
  isOpen(): boolean
}

/** Routing table. Single source of truth for "which shim should I
 *  send this session's notifications to right now?" */
export class SessionRouter {
  private bySession = new Map<string, NotificationSink>()
  private sessionBySink = new WeakMap<NotificationSink, string>()

  /** Bind a session to a sink. If the session was already bound to
   *  another sink (e.g. shim reconnect during a network blip), the
   *  old sink is dropped — the freshly-registered shim wins. */
  bind(sessionId: string, sink: NotificationSink): void {
    const prior = this.bySession.get(sessionId)
    if (prior && prior !== sink) {
      // Best-effort: don't close the old sink, just drop the binding.
      // The daemon's per-connection close handler will handle it.
    }
    this.bySession.set(sessionId, sink)
    this.sessionBySink.set(sink, sessionId)
  }

  /** Drop a session binding by id. Used by the deregister handler. */
  unbindBySession(sessionId: string): void {
    const sink = this.bySession.get(sessionId)
    this.bySession.delete(sessionId)
    if (sink) this.sessionBySink.delete(sink)
  }

  /** Drop a session binding by sink. Used when a connection closes
   *  uncleanly (CC crash, socket reset) — we don't know the
   *  session_id from the socket alone unless we recorded it on
   *  register. */
  unbindBySink(sink: NotificationSink): string | null {
    const id = this.sessionBySink.get(sink) ?? null
    if (id !== null) {
      this.bySession.delete(id)
      this.sessionBySink.delete(sink)
    }
    return id
  }

  /** Sink for a session, or null if not currently connected. The
   *  null case means the daemon should buffer notifications via
   *  `enqueuePendingNotification`. */
  sinkFor(sessionId: string): NotificationSink | null {
    const sink = this.bySession.get(sessionId)
    if (!sink) return null
    if (!sink.isOpen()) {
      this.bySession.delete(sessionId)
      this.sessionBySink.delete(sink)
      return null
    }
    return sink
  }

  /** Snapshot of currently-connected session ids — used by admin /
   *  observability surfaces. */
  connectedSessionIds(): string[] {
    return [...this.bySession.keys()]
  }
}
