/**
 * In-memory session-routing table. Maps `session_id` to the currently
 * connected shim's socket so the daemon can push notifications back to
 * the right CC session. Lives only in the daemon process; the DB is
 * the durable store for everything else.
 */

/** Anything that can write a line of NDJSON. The RPC server's per-
 *  connection socket implements this; tests can pass a mock. Write
 *  returns false when the underlying transport has gone — callers
 *  re-buffer via `enqueuePendingNotification` in that case so the
 *  notification isn't silently dropped. */
export interface NotificationSink {
  write(line: string): boolean
  /** True iff the underlying transport is still open. */
  isOpen(): boolean
}

/** Routing table. Single source of truth for "which shim should I
 *  send this session's notifications to right now?" */
export class SessionRouter {
  private bySession = new Map<string, NotificationSink>()
  private sessionBySink = new WeakMap<NotificationSink, string>()

  /** Bind a session to a sink. If the session was already bound to a
   *  different sink (shim reconnect during a network blip, or two
   *  shims racing with the same session_id), the prior sink's reverse
   *  entry is cleared so that when the OS later delivers its `close`
   *  event we don't tear down the *new* binding via `unbindBySink`. */
  bind(sessionId: string, sink: NotificationSink): void {
    const prior = this.bySession.get(sessionId)
    if (prior && prior !== sink) {
      this.sessionBySink.delete(prior)
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
   *  uncleanly (CC crash, socket reset). No-op when the sink has
   *  already been replaced by a newer one for the same session — the
   *  reverse lookup will miss and we won't accidentally tear down the
   *  fresh binding. */
  unbindBySink(sink: NotificationSink): string | null {
    const id = this.sessionBySink.get(sink) ?? null
    if (id !== null) {
      // Only clear the forward binding if it still points at THIS sink.
      // Otherwise a newer connection for the same session has replaced
      // it and we must not touch it.
      if (this.bySession.get(id) === sink) {
        this.bySession.delete(id)
      }
      this.sessionBySink.delete(sink)
    }
    return id
  }

  /** Sink for a session, or null if not currently connected. The null
   *  case means the daemon should buffer notifications via
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
