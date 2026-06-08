/**
 * Session-renewal recognition.
 *
 * Emits atomic presence events (leave/join/rename) immediately, then
 * recognizes the renewal pattern at the moment a same-name claim
 * arrives and emits a `session_renewed` witness event. The witness
 * carries the old session id so consumers can correlate it with the
 * preceding `leave` and render the (leave, session_renewed) pair as
 * a single identity transition.
 *
 * # Invariants
 *
 * - **No deferral**: every atomic event fires synchronously at the
 *   moment of its trigger. The daemon never holds an event waiting
 *   for context. Fast exits, fast joins.
 * - **Recognition, not replacement**: `session_renewed` is an
 *   *additional* event, not a substitute. The preceding `leave`
 *   still fires; the witness frames it retroactively.
 * - **Bounded memory**: vacated names age out of the cache after
 *   `vacatedTtlMs`. A claim that arrives later than that gets the
 *   normal LWW/rename path with no renewal recognition.
 * - **At most one entry per name**: when the same name is vacated
 *   twice in quick succession (rare; the DB's unique constraint on
 *   `display_name` normally prevents this), the second entry
 *   replaces the first — the most recent vacator wins the renewal
 *   matchup.
 * - **Single-threaded (Bun event loop)**: every transition runs to
 *   completion before any timer callback executes. No locks needed.
 */

import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { broadcastPresence } from '#choros/daemon/notify.ts'
import { NOTIFY_PRESENCE } from '#choros/protocol/notifications.ts'

/** Timer abstraction so tests inject a FakeClock and avoid wall-clock
 *  flakiness. */
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

interface VacatedEntry {
  sessionId: string
  displayName: string
  evictTimer: TimerHandle
}

/** Recognizes session renewals at claim-time. Maintains a TTL'd map
 *  of recently-vacated display names; on a same-name claim within
 *  the TTL, emits a `session_renewed` witness event and tells the
 *  caller to suppress the would-be `name_evicted` + `rename` pair.
 *
 *  No deferral of atomic events: leave fires immediately on
 *  deregister, join fires immediately on register. The renewal
 *  pattern is recognized retroactively when the claim arrives. */
export class RenewalCoordinator {
  private vacated = new Map<string, VacatedEntry>()

  constructor(
    private readonly clock: Clock,
    private readonly vacatedTtlMs: number,
  ) {}

  /** Called by the deregister handler. Fires `leave` immediately
   *  (no waiting), then records the (name, session) pair in the
   *  vacated cache so a same-name claim arriving within
   *  `vacatedTtlMs` can be recognized as a renewal. Unnamed
   *  disconnects only fire `leave`; there's nothing to record. */
  recordLeave(ctx: HandlerCtx, sessionId: string, displayName: string | null): void {
    broadcastPresence(ctx, 'leave', sessionId, displayName)
    if (displayName === null) return
    const prior = this.vacated.get(displayName)
    if (prior !== undefined) {
      // Replace: the most recent vacator wins. The prior entry's
      // potential renewer (if any) missed its window; the new
      // entry takes over the slot.
      this.clock.clearTimeout(prior.evictTimer)
    }
    const evictTimer = this.clock.setTimeout(() => {
      this.vacated.delete(displayName)
    }, this.vacatedTtlMs)
    this.vacated.set(displayName, { sessionId, displayName, evictTimer })
  }

  /** Called by the set_display_name handler before its eviction +
   *  rename broadcasts. If `name` is in the vacated cache, removes
   *  it and returns `{ kind: 'renewed', oldSessionId }` so the
   *  caller can emit `session_renewed` and SKIP `name_evicted` +
   *  `rename`. Otherwise returns `{ kind: 'normal' }` and the caller
   *  proceeds with the standard LWW path. */
  tryRecognizeRenewal(name: string): RecognitionOutcome {
    const entry = this.vacated.get(name)
    if (entry === undefined) return { kind: 'normal' }
    this.clock.clearTimeout(entry.evictTimer)
    this.vacated.delete(name)
    return { kind: 'renewed', oldSessionId: entry.sessionId }
  }

  /** Drop every TTL timer without flushing. Called by the daemon's
   *  shutdown path; the in-memory cache is transient and clients
   *  reconcile via roster on reconnect. */
  shutdown(): void {
    for (const e of this.vacated.values()) this.clock.clearTimeout(e.evictTimer)
    this.vacated.clear()
  }

  /** Diagnostic snapshot for tests + doctor probes. */
  vacatedCount(): number {
    return this.vacated.size
  }
}

export type RecognitionOutcome = { kind: 'renewed'; oldSessionId: string } | { kind: 'normal' }

/** Broadcast a `session_renewed` event — the witness for a renewal
 *  pattern recognized at claim-time. Frames the immediately-prior
 *  `leave(old)` as the departure half of an identity transition.
 *  Uses the NOTIFY_PRESENCE channel with a distinct `event` value.
 *  Skips the renewer itself (old session is gone) AND the claimant
 *  (it already knows it just claimed the name). */
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
