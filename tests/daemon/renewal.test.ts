/**
 * Session-renewal coalescing tests.
 *
 * Two levels:
 *   - RenewalCoordinator unit tests with a FakeClock so timer expiry
 *     is deterministic and we don't pay wall-clock time per test.
 *   - End-to-end integration tests through the daemon's RPC surface,
 *     with a small (5-10 ms) real window — fast enough to keep the
 *     suite snappy, large enough that the timer doesn't fire before
 *     a same-tick claim arrives.
 *
 * Each test name encodes which invariant (I1-I6) or counterexample
 * (C1-C9) from the /solve proof it pins.
 */

import { describe, expect, test } from 'bun:test'
import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import type { Clock, TimerHandle } from '#choros/daemon/renewal.ts'
import { RenewalCoordinator } from '#choros/daemon/renewal.ts'
import { PROTOCOL_VERSION } from '#choros/protocol/methods.ts'
import { connectTestClient, spawnTestDaemon } from './fixtures.ts'

// ──────────────────────────────────────────────────────────────────
// FakeClock for unit tests: timers are manual-advance, not wall-clock.
// ──────────────────────────────────────────────────────────────────

interface FakeTimer {
  cb: () => void
  fireAtMs: number
  id: number
}

class FakeClock implements Clock {
  private now = 0
  private timers: FakeTimer[] = []
  private nextId = 1

  setTimeout(cb: () => void, ms: number): TimerHandle {
    const t: FakeTimer = { cb, fireAtMs: this.now + ms, id: this.nextId++ }
    this.timers.push(t)
    return t as unknown as TimerHandle
  }

  clearTimeout(handle: TimerHandle): void {
    const target = handle as unknown as FakeTimer
    this.timers = this.timers.filter(t => t.id !== target.id)
  }

  advanceBy(ms: number): void {
    this.now += ms
    const due = this.timers.filter(t => t.fireAtMs <= this.now)
    this.timers = this.timers.filter(t => t.fireAtMs > this.now)
    for (const t of due) t.cb()
  }

  pendingCount(): number {
    return this.timers.length
  }
}

// ──────────────────────────────────────────────────────────────────
// Broadcast spy: records every presence/renewed event emitted via the
// HandlerCtx-equivalent passed to the coordinator. Replaces the
// daemon's sink layer so tests can inspect ordering without sockets.
// ──────────────────────────────────────────────────────────────────

interface SpyEvent {
  kind: 'join' | 'leave' | 'rename' | 'name_evicted' | 'session_renewed'
  sessionId: string
  oldSessionId?: string
  displayName: string | null
  oldName?: string | null
}

function buildSpyCtx(): { ctx: HandlerCtx; events: SpyEvent[] } {
  const events: SpyEvent[] = []
  // Capture broadcasts at the sink layer: a synthetic router with one
  // observer-peer whose sink parses every frame and records the event.
  // No storage operations occur on the broadcast paths, so the storage
  // stub is just enough to satisfy the type.
  const ctx = {
    storage: {
      db: {
        query: (): { run: () => void; all: () => unknown[] } => ({
          run: (): void => undefined,
          all: (): unknown[] => [],
        }),
      },
    },
    router: {
      connectedSessionIds: (): string[] => ['observer-session'],
      sinkFor: (): { write: (frame: string) => boolean } => ({
        write: (frame: string): boolean => {
          const msg = JSON.parse(frame) as {
            method: string
            params: {
              event: string
              session_id: string
              old_session_id?: string
              display_name: string | null
              old_name?: string | null
            }
          }
          events.push({
            kind: msg.params.event as SpyEvent['kind'],
            sessionId: msg.params.session_id,
            ...(msg.params.old_session_id !== undefined && {
              oldSessionId: msg.params.old_session_id,
            }),
            displayName: msg.params.display_name,
            ...(msg.params.old_name !== undefined && { oldName: msg.params.old_name }),
          })
          return true
        },
      }),
      setDisplayName: (): void => undefined,
      displayNameFor: (): string | null => null,
    },
    daemon: { version: 'test', startedAt: new Date(0).toISOString() },
    nowIso: (): string => new Date(0).toISOString(),
  } as unknown as HandlerCtx
  return { ctx, events }
}

// ──────────────────────────────────────────────────────────────────
// Unit tests against RenewalCoordinator with FakeClock.
// ──────────────────────────────────────────────────────────────────

describe('RenewalCoordinator (unit, FakeClock)', () => {
  test('I1: leave fires after window when no same-name claim arrives', () => {
    const clock = new FakeClock()
    const { ctx, events } = buildSpyCtx()
    const r = new RenewalCoordinator(clock, 100, 500)
    r.enterPendingLeave(ctx, 'sess-X', 'w3-config')
    expect(events).toHaveLength(0)
    clock.advanceBy(499)
    expect(events).toHaveLength(0)
    clock.advanceBy(1)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'leave',
      sessionId: 'sess-X',
      displayName: 'w3-config',
    })
  })

  test('I2: same-name claim within window emits one session_renewed, zero atomic events', () => {
    const clock = new FakeClock()
    const { ctx, events } = buildSpyCtx()
    const r = new RenewalCoordinator(clock, 100, 500)
    r.enterPendingLeave(ctx, 'sess-X', 'w3-config')
    r.enterPendingJoin(ctx, 'sess-A', 'w3-config')
    const outcome = r.tryRenewal('w3-config', 'sess-A')
    expect(outcome).toMatchObject({ kind: 'renewed', oldSessionId: 'sess-X' })
    // Caller (set_display_name) issues broadcastSessionRenewed; the
    // coordinator itself emits nothing on this path. Verify no
    // atomic events leaked from the deferral.
    expect(events).toHaveLength(0)
    // Confirm the timers were cancelled — advancing past the window
    // must not fire any deferred broadcast.
    clock.advanceBy(10_000)
    expect(events).toHaveLength(0)
    expect(r.pendingCounts()).toEqual({ joins: 0, leaves: 0 })
  })

  test('I3: claim of unheld name returns normal (no renewal)', () => {
    const clock = new FakeClock()
    const { ctx } = buildSpyCtx()
    const r = new RenewalCoordinator(clock, 100, 500)
    r.enterPendingJoin(ctx, 'sess-A', null)
    const outcome = r.tryRenewal('w3-config', 'sess-A')
    expect(outcome).toEqual({ kind: 'normal' })
  })

  test('I4: two-claimant — first wins renewal, second sees normal path', () => {
    const clock = new FakeClock()
    const { ctx } = buildSpyCtx()
    const r = new RenewalCoordinator(clock, 100, 500)
    r.enterPendingLeave(ctx, 'sess-X', 'w3-config')
    r.enterPendingJoin(ctx, 'sess-B', null)
    r.enterPendingJoin(ctx, 'sess-C', null)
    const first = r.tryRenewal('w3-config', 'sess-B')
    const second = r.tryRenewal('w3-config', 'sess-C')
    expect(first).toMatchObject({ kind: 'renewed', oldSessionId: 'sess-X' })
    expect(second).toEqual({ kind: 'normal' })
  })

  test('I5: shutdown drops every pending timer without firing', () => {
    const clock = new FakeClock()
    const { ctx, events } = buildSpyCtx()
    const r = new RenewalCoordinator(clock, 100, 500)
    r.enterPendingJoin(ctx, 'sess-A', null)
    r.enterPendingLeave(ctx, 'sess-X', 'name1')
    r.enterPendingLeave(ctx, 'sess-Y', 'name2')
    expect(clock.pendingCount()).toBeGreaterThan(0)
    r.shutdown()
    expect(clock.pendingCount()).toBe(0)
    expect(r.pendingCounts()).toEqual({ joins: 0, leaves: 0 })
    clock.advanceBy(10_000)
    expect(events).toHaveLength(0)
  })

  test('I6: cancelPendingJoin drops the deferred join silently', () => {
    const clock = new FakeClock()
    const { ctx, events } = buildSpyCtx()
    const r = new RenewalCoordinator(clock, 100, 500)
    r.enterPendingJoin(ctx, 'sess-A', null)
    const cancelled = r.cancelPendingJoin('sess-A')
    expect(cancelled).toBe(true)
    clock.advanceBy(10_000)
    expect(events).toHaveLength(0)
  })

  test('C1: t1 firing during deregister (FakeClock interleave is deterministic)', () => {
    // Simulate the race: register fires t1, then deregister cancels.
    // FakeClock guarantees order: timer fires only on advanceBy.
    const clock = new FakeClock()
    const { ctx, events } = buildSpyCtx()
    const r = new RenewalCoordinator(clock, 100, 500)
    r.enterPendingJoin(ctx, 'sess-A', 'foo')
    // Deregister happens BEFORE timer fires: flush join, then enter leave.
    r.flushPendingJoinIfAny(ctx, 'sess-A')
    r.enterPendingLeave(ctx, 'sess-A', 'foo')
    // Now advance past the join window — no extra event.
    clock.advanceBy(150)
    expect(events.filter(e => e.kind === 'join')).toHaveLength(1)
    // Advance past the leave window.
    clock.advanceBy(500)
    expect(events.filter(e => e.kind === 'leave')).toHaveLength(1)
  })

  test('C2: two t2 timers for the same name — second supersedes first', () => {
    const clock = new FakeClock()
    const { ctx, events } = buildSpyCtx()
    const r = new RenewalCoordinator(clock, 100, 500)
    r.enterPendingLeave(ctx, 'sess-X', 'w3-config')
    // Second enterPendingLeave for the same name (pathological — DB
    // unique constraint normally prevents it). Implementation: flush
    // the prior immediately, install the new timer.
    r.enterPendingLeave(ctx, 'sess-Y', 'w3-config')
    // First leave flushed immediately on replacement.
    expect(events.filter(e => e.kind === 'leave' && e.sessionId === 'sess-X')).toHaveLength(1)
    clock.advanceBy(500)
    expect(events.filter(e => e.kind === 'leave' && e.sessionId === 'sess-Y')).toHaveLength(1)
  })

  test('C5: rapid restart loop — every restart yields one session_renewed', () => {
    const clock = new FakeClock()
    const { ctx, events } = buildSpyCtx()
    const r = new RenewalCoordinator(clock, 100, 500)
    // X disconnects, then A claims (renewal 1).
    r.enterPendingLeave(ctx, 'sess-X', 'name')
    r.enterPendingJoin(ctx, 'sess-A', null)
    const o1 = r.tryRenewal('name', 'sess-A')
    expect(o1).toMatchObject({ kind: 'renewed', oldSessionId: 'sess-X' })
    // A disconnects, B claims (renewal 2).
    r.enterPendingLeave(ctx, 'sess-A', 'name')
    r.enterPendingJoin(ctx, 'sess-B', null)
    const o2 = r.tryRenewal('name', 'sess-B')
    expect(o2).toMatchObject({ kind: 'renewed', oldSessionId: 'sess-A' })
    expect(events).toHaveLength(0)
  })

  test('zero-window mode broadcasts synchronously (no timer)', () => {
    const clock = new FakeClock()
    const { ctx, events } = buildSpyCtx()
    const r = new RenewalCoordinator(clock, 0, 0)
    r.enterPendingJoin(ctx, 'sess-A', 'foo')
    expect(events).toEqual([
      expect.objectContaining({ kind: 'join', sessionId: 'sess-A', displayName: 'foo' }),
    ])
    expect(clock.pendingCount()).toBe(0)
    r.enterPendingLeave(ctx, 'sess-A', 'foo')
    expect(events.filter(e => e.kind === 'leave')).toHaveLength(1)
    expect(clock.pendingCount()).toBe(0)
  })

  test('unnamed leave fires immediately regardless of window', () => {
    const clock = new FakeClock()
    const { ctx, events } = buildSpyCtx()
    const r = new RenewalCoordinator(clock, 100, 500)
    r.enterPendingLeave(ctx, 'sess-A', null)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'leave', sessionId: 'sess-A', displayName: null })
    expect(clock.pendingCount()).toBe(0)
  })

  test('renewal requires pending leave only (joined claimant also coalesces)', () => {
    const clock = new FakeClock()
    const { ctx } = buildSpyCtx()
    const r = new RenewalCoordinator(clock, 100, 500)
    // Pending leave for the name → renewal fires regardless of the
    // claimant's pending-join state. Empirically the new shim's
    // set_display_name often arrives after its own join timer expired;
    // gating on pendingJoin would miss the common case. A Joined
    // claimant renaming to a recently-vacated name also fires
    // session_renewed — observably correct.
    r.enterPendingLeave(ctx, 'sess-X', 'w3-config')
    expect(r.tryRenewal('w3-config', 'sess-B')).toMatchObject({
      kind: 'renewed',
      oldSessionId: 'sess-X',
    })
    // No pending leave → normal path.
    r.enterPendingJoin(ctx, 'sess-A', null)
    expect(r.tryRenewal('fresh-name', 'sess-A')).toEqual({ kind: 'normal' })
  })
})

// ──────────────────────────────────────────────────────────────────
// Integration tests through the daemon RPC surface with a small
// real-clock window. Window=20ms is enough that an in-process RPC
// claim arrives before timer expiry on any reasonable hardware.
// ──────────────────────────────────────────────────────────────────

const PEER_X = 'eeeeeeee-0000-0000-0000-000000000001'
const PEER_A = 'eeeeeeee-0000-0000-0000-000000000002'
const PEER_OBSERVER = 'eeeeeeee-0000-0000-0000-000000000099'

async function registerClient(daemon: { socketPath: string }, sessionId: string, name?: string) {
  const client = await connectTestClient(daemon.socketPath)
  await client.call('choros.register', {
    protocol_version: PROTOCOL_VERSION,
    session_id: sessionId,
    display_name: name ?? null,
    host: 'test',
    cwd: '/tmp',
    pid: Math.floor(Math.random() * 100_000),
  })
  return client
}

describe('renewal coalescing (integration)', () => {
  test('renewal emits one session_renewed; observer sees no leave / no join / no rename', async () => {
    const daemon = spawnTestDaemon({ claimWindowMs: 50, renewalWindowMs: 200 })
    try {
      const observer = await registerClient(daemon, PEER_OBSERVER, 'observer')
      // Subscribe BEFORE X registers — the fixture's nextNotification
      // drops notifications that arrive before a waiter exists.
      const xJoinP = observer.nextNotification('choros.presence')
      const x = await registerClient(daemon, PEER_X, 'w3-config')
      const xJoin = (await xJoinP) as { event: string }
      expect(xJoin.event).toBe('join')

      // Subscribe for the renewal event BEFORE deregister + set_display_name.
      const renewedP = observer.nextNotification('choros.presence')

      await x.call('choros.deregister', { session_id: PEER_X })
      const a = await registerClient(daemon, PEER_A)
      await a.call('choros.set_display_name', {
        session_id: PEER_A,
        display_name: 'w3-config',
      })

      const renewed = (await renewedP) as {
        event: string
        session_id: string
        old_session_id: string
        display_name: string
      }
      expect(renewed.event).toBe('session_renewed')
      expect(renewed.session_id).toBe(PEER_A)
      expect(renewed.old_session_id).toBe(PEER_X)
      expect(renewed.display_name).toBe('w3-config')

      await observer.close()
      await x.close()
      await a.close()
    } finally {
      await daemon.stop()
    }
  })

  test('no renewal when window expires before claim — observer sees leave', async () => {
    const daemon = spawnTestDaemon({ claimWindowMs: 5, renewalWindowMs: 20 })
    try {
      const observer = await registerClient(daemon, PEER_OBSERVER, 'observer')
      const xJoinP = observer.nextNotification('choros.presence')
      const x = await registerClient(daemon, PEER_X, 'w3-config')
      await xJoinP

      const leaveP = observer.nextNotification('choros.presence')
      await x.call('choros.deregister', { session_id: PEER_X })

      const leave = (await leaveP) as { event: string; session_id: string }
      expect(leave.event).toBe('leave')
      expect(leave.session_id).toBe(PEER_X)

      await observer.close()
      await x.close()
    } finally {
      await daemon.stop()
    }
  })
})
