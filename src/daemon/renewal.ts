/**
 * Session-renewal coalescing.
 *
 * Coalesces a (leave, join, name_evicted, rename) sequence into a single
 * `session_renewed` event when a CC `/exit`-then-relaunch reclaims the
 * same display name within RENEWAL_WINDOW_MS. Atomic events remain the
 * protocol's primitives; this module is the deferred-publication layer
 * that emits the composite witness when the sequence completes.
 *
 * # Invariants
 *
 * - **Single-threaded (Bun event loop)**: every transition runs to
 *   completion before any timer callback executes. No SQL or socket
 *   work happens between the state read and the state mutation, so
 *   the maps and the broadcasts stay consistent without locks.
 * - **At most one pending entry per key**: each session_id has at most
 *   one `Pending` join; each display_name has at most one
 *   `PendingLeave`. The DB's unique constraint on `display_name`
 *   structurally enforces the latter.
 * - **Timer cancellation is the only abort path**: a pending entry
 *   exits state only via `flush*` (callback or external) or via
 *   `cancel*`. No silent expiry.
 * - **Shutdown drops, does not flush**: deferred broadcasts are
 *   transient; on daemon shutdown they vanish and clients reconcile
 *   via roster on reconnect.
 */

import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { broadcastPresence } from '#choros/daemon/notify.ts'
import { NOTIFY_PRESENCE } from '#choros/protocol/notifications.ts'

/** Timer abstraction so tests inject a FakeClock and avoid wall-clock
 *  flakiness. Real implementation wraps Node's setTimeout/clearTimeout
 *  via an opaque handle so callers don't see the platform difference. */
export interface Clock {
  setTimeout(cb: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

export type TimerHandle = { readonly __brand: 'TimerHandle' } | NodeJS.Timeout

export const realClock: Clock = {
  setTimeout(cb, ms) {
    return setTimeout(cb, ms) as TimerHandle
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout)
  },
}

interface PendingJoin {
  sessionId: string
  displayName: string | null
  timer: TimerHandle
}

interface PendingLeave {
  sessionId: string
  displayName: string
  timer: TimerHandle
}

/** Per-daemon coalescing state. Owns the two pending maps and decides
 *  whether each transition flushes or suppresses the underlying
 *  broadcast. Tests drive it directly via a FakeClock; production wires
 *  it via the daemon's HandlerCtx. */
export class RenewalCoordinator {
  private pendingJoins = new Map<string, PendingJoin>()
  private pendingLeaves = new Map<string, PendingLeave>()

  constructor(
    private readonly clock: Clock,
    private readonly claimWindowMs: number,
    private readonly renewalWindowMs: number,
  ) {}

  /** Called by the register handler. Defers `join(sessionId)`; if a
   *  matching `set_display_name` arrives before the timer fires, the
   *  join either turns into a `session_renewed` or flushes normally
   *  alongside `rename`. Idempotent: a second register for the same
   *  session_id replaces the prior pending join's timer. */
  enterPendingJoin(ctx: HandlerCtx, sessionId: string, displayName: string | null): void {
    // Zero-window short-circuit: don't schedule a timer; broadcast
    // synchronously. Restores observable equivalence with the pre-
    // renewal daemon for tests that opt out of coalescing, and
    // sidesteps the setTimeout(0) race between handler return and
    // timer callback that would otherwise leave the broadcast in
    // limbo for one event loop tick.
    if (this.claimWindowMs === 0) {
      broadcastPresence(ctx, 'join', sessionId, displayName)
      return
    }
    const prior = this.pendingJoins.get(sessionId)
    if (prior !== undefined) {
      this.clock.clearTimeout(prior.timer)
    }
    const timer = this.clock.setTimeout(() => {
      this.pendingJoins.delete(sessionId)
      broadcastPresence(ctx, 'join', sessionId, displayName)
    }, this.claimWindowMs)
    this.pendingJoins.set(sessionId, { sessionId, displayName, timer })
  }

  /** Called by the deregister handler. Defers `leave(sessionId, name)`
   *  when the session held a display name; if a matching
   *  `set_display_name(name, _)` arrives before the timer fires the
   *  pair is coalesced into `session_renewed`. Unnamed disconnects
   *  bypass this and fire `leave` immediately (no renewal can apply).
   */
  enterPendingLeave(ctx: HandlerCtx, sessionId: string, displayName: string | null): void {
    if (displayName === null) {
      broadcastPresence(ctx, 'leave', sessionId, null)
      return
    }
    if (this.renewalWindowMs === 0) {
      // Zero-window short-circuit (see enterPendingJoin).
      broadcastPresence(ctx, 'leave', sessionId, displayName)
      return
    }
    const prior = this.pendingLeaves.get(displayName)
    if (prior !== undefined) {
      // Replace: an older pending-leave for the same name (e.g. two
      // sessions held the name in close succession) flushes
      // immediately before the new one enters its window. The DB's
      // unique constraint normally prevents this, but a stale cached
      // displayName can still collide; flushing keeps the visible
      // sequence linear.
      this.clock.clearTimeout(prior.timer)
      broadcastPresence(ctx, 'leave', prior.sessionId, prior.displayName)
    }
    const timer = this.clock.setTimeout(() => {
      this.pendingLeaves.delete(displayName)
      broadcastPresence(ctx, 'leave', sessionId, displayName)
    }, this.renewalWindowMs)
    this.pendingLeaves.set(displayName, { sessionId, displayName, timer })
  }

  /** Called by the set_display_name handler with the claiming session
   *  and the requested name. Returns:
   *   - `{ kind: 'renewed', oldSessionId }` if the claim coalesces a
   *     pending-leave (the caller broadcasts `session_renewed` and
   *     SKIPS broadcasting join / name_evicted / rename for the pair).
   *   - `{ kind: 'normal' }` otherwise — the caller falls through to
   *     the existing LWW/rename broadcast path AND should call
   *     `flushPendingJoinIfAny` before broadcasting join.
   */
  tryRenewal(name: string, claimingSessionId: string): RenewalOutcome {
    const pendingLeave = this.pendingLeaves.get(name)
    const pendingJoin = this.pendingJoins.get(claimingSessionId)
    // Renewal requires both: a vacated name AND a freshly-connected
    // claimant. An already-joined session claiming a vacated name is a
    // voluntary rename, not a renewal — it flushes normally.
    if (pendingLeave === undefined || pendingJoin === undefined) {
      return { kind: 'normal' }
    }
    this.clock.clearTimeout(pendingLeave.timer)
    this.clock.clearTimeout(pendingJoin.timer)
    this.pendingLeaves.delete(name)
    this.pendingJoins.delete(claimingSessionId)
    return { kind: 'renewed', oldSessionId: pendingLeave.sessionId }
  }

  /** Called by the set_display_name handler on the normal (non-renewal)
   *  path before it broadcasts rename. Flushes any deferred join for
   *  this session so live peers see `join` before `rename` rather than
   *  `rename` for an unannounced session. Returns true if a join was
   *  flushed (the caller's broadcastPresence('join') would be a dup). */
  flushPendingJoinIfAny(ctx: HandlerCtx, sessionId: string): boolean {
    const pending = this.pendingJoins.get(sessionId)
    if (pending === undefined) return false
    this.clock.clearTimeout(pending.timer)
    this.pendingJoins.delete(sessionId)
    broadcastPresence(ctx, 'join', sessionId, pending.displayName)
    return true
  }

  /** Called by the deregister handler before entering PendingLeave, in
   *  case the session disconnects while still in `Pending` (joined-
   *  in-name-only, never confirmed). Discards the deferred join
   *  silently — the session came and went without ever being visible. */
  cancelPendingJoin(sessionId: string): boolean {
    const pending = this.pendingJoins.get(sessionId)
    if (pending === undefined) return false
    this.clock.clearTimeout(pending.timer)
    this.pendingJoins.delete(sessionId)
    return true
  }

  /** Drop every pending timer without flushing. Called by the daemon's
   *  shutdown path: deferred broadcasts are transient and clients
   *  reconcile on reconnect; firing them post-shutdown would race the
   *  socket close. */
  shutdown(): void {
    for (const p of this.pendingJoins.values()) this.clock.clearTimeout(p.timer)
    for (const p of this.pendingLeaves.values()) this.clock.clearTimeout(p.timer)
    this.pendingJoins.clear()
    this.pendingLeaves.clear()
  }

  /** Diagnostic snapshot for tests + doctor probes. */
  pendingCounts(): { joins: number; leaves: number } {
    return { joins: this.pendingJoins.size, leaves: this.pendingLeaves.size }
  }
}

export type RenewalOutcome = { kind: 'renewed'; oldSessionId: string } | { kind: 'normal' }

/** Broadcast a `session_renewed` event — the composite witness for a
 *  coalesced (leave, join, name_evicted, rename) sequence. Uses the
 *  same NOTIFY_PRESENCE channel as the atomic events with a distinct
 *  `event` value so consumers can filter on it. Skips the renewer
 *  itself (its prior identity is gone) AND the new claimant (it
 *  already knows it just claimed the name). */
export function broadcastSessionRenewed(
  ctx: HandlerCtx,
  oldSessionId: string,
  newSessionId: string,
  displayName: string,
): void {
  const body = `${displayName} renewed (${oldSessionId.slice(0, 8)} → ${newSessionId.slice(0, 8)})`
  const params: Record<string, unknown> = {
    event: 'session_renewed',
    session_id: newSessionId,
    old_session_id: oldSessionId,
    display_name: displayName,
    body,
    ts: ctx.nowIso(),
  }
  const frame = JSON.stringify({ jsonrpc: '2.0', method: NOTIFY_PRESENCE, params })
  for (const peerId of ctx.router.connectedSessionIds()) {
    if (peerId === oldSessionId || peerId === newSessionId) continue
    const sink = ctx.router.sinkFor(peerId)
    if (!sink) continue
    try {
      sink.write(frame)
    } catch {
      /* dead-sink during best-effort fan-out — presence is non-durable */
    }
  }
}
