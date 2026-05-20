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
  /** In-memory mirror of `sessions.display_name` for currently-bound
   *  sessions, populated at bind() time and updated by the
   *  set_display_name handler. Lets fan-out paths skip a SELECT per
   *  send/broadcast/publish. */
  private displayName = new Map<string, string | null>()

  /** Bind a session to a sink. Two stale-entry hazards to clear:
   *
   *  1. The session was bound to a *different* sink (shim reconnect, or
   *     two shims racing the same session_id): drop the prior sink's
   *     reverse entry so its later `close` event doesn't tear down this
   *     fresh binding via `unbindBySink`.
   *
   *  2. This sink was bound to a *different* session (identity rotation
   *     on one connection — register-as-A then register-as-B): drop the
   *     prior session's forward entry, else `bySession` keeps a dangling
   *     `A→sink` and notifications addressed to A get delivered to B's
   *     connection (cross-session leak). Symmetric to unbindBySink. */
  bind(sessionId: string, sink: NotificationSink, displayName: string | null): void {
    const priorSink = this.bySession.get(sessionId)
    if (priorSink && priorSink !== sink) {
      this.sessionBySink.delete(priorSink)
    }
    const priorSession = this.sessionBySink.get(sink)
    if (priorSession !== undefined && priorSession !== sessionId) {
      this.bySession.delete(priorSession)
      this.displayName.delete(priorSession)
    }
    this.bySession.set(sessionId, sink)
    this.sessionBySink.set(sink, sessionId)
    this.displayName.set(sessionId, displayName)
  }

  /** Drop a session binding by id. Used by the deregister handler. */
  unbindBySession(sessionId: string): void {
    const sink = this.bySession.get(sessionId)
    this.bySession.delete(sessionId)
    this.displayName.delete(sessionId)
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
        this.displayName.delete(id)
      }
      this.sessionBySink.delete(sink)
    }
    return id
  }

  /** Update the cached display name for a bound session. Called by
   *  the set_display_name handler after persisting to SQLite. */
  setDisplayName(sessionId: string, displayName: string | null): void {
    if (this.bySession.has(sessionId)) {
      this.displayName.set(sessionId, displayName)
    }
  }

  /** Cached display name for a session, or `undefined` if not in cache
   *  (caller falls back to a DB SELECT). Returns `null` to mean
   *  "session exists but has no display name", distinct from the
   *  cache-miss case. */
  displayNameFor(sessionId: string): string | null | undefined {
    return this.displayName.get(sessionId)
  }

  /** The session id bound to a connection's sink, or null if the sink
   *  hasn't registered. The dispatch boundary uses this to verify a
   *  request's `session_id` param actually belongs to the calling
   *  connection — without it any local session could act as another
   *  by passing a foreign session_id. */
  sessionForSink(sink: NotificationSink): string | null {
    return this.sessionBySink.get(sink) ?? null
  }

  /** Sink for a session, or null if not currently connected. The null
   *  case means the daemon should buffer notifications via
   *  `enqueuePendingNotification`. On a stale (closed) sink, drop ALL
   *  three maps consistently — leaving displayName behind would let
   *  the next fan-out hand out a stale name for a session that no
   *  longer has a sink. */
  sinkFor(sessionId: string): NotificationSink | null {
    const sink = this.bySession.get(sessionId)
    if (!sink) return null
    if (!sink.isOpen()) {
      this.bySession.delete(sessionId)
      this.displayName.delete(sessionId)
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
