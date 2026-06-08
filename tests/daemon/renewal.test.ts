/**
 * Session-renewal recognition tests.
 *
 * The witness-as-event design: atomic events fire immediately, the
 * `session_renewed` witness is emitted retroactively when a same-name
 * claim arrives within VACATED_TTL_MS of the corresponding leave.
 *
 * Two levels:
 *   - Unit tests with a FakeClock pin the coordinator's recognition
 *     logic and the TTL cache behavior deterministically.
 *   - Integration tests through the daemon RPC surface verify the
 *     full wire-level event sequence per scenario from the design.
 */

import { describe, expect, test } from 'bun:test'
import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import type { Clock, TimerHandle } from '#choros/daemon/renewal.ts'
import { RenewalCoordinator } from '#choros/daemon/renewal.ts'
import { PROTOCOL_VERSION } from '#choros/protocol/methods.ts'
import { connectTestClient, spawnTestDaemon } from './fixtures.ts'

// ──────────────────────────────────────────────────────────────────
// FakeClock — manual-advance timers.
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
// Broadcast spy: captures every presence frame routed through the
// daemon's broadcastPresence path so tests can inspect ordering.
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
// Unit tests against RenewalCoordinator (witness-as-event design).
// ──────────────────────────────────────────────────────────────────

describe('RenewalCoordinator (witness-as-event, FakeClock)', () => {
  test('recordLeave fires leave immediately and seeds the vacated cache', () => {
    const clock = new FakeClock()
    const { ctx, events } = buildSpyCtx()
    const r = new RenewalCoordinator(clock, 60_000)
    r.recordLeave(ctx, 'sess-X', 'w3-config')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'leave',
      sessionId: 'sess-X',
      displayName: 'w3-config',
    })
    expect(r.vacatedCount()).toBe(1)
  })

  test('claim within TTL is recognized as renewal', () => {
    const clock = new FakeClock()
    const { ctx } = buildSpyCtx()
    const r = new RenewalCoordinator(clock, 60_000)
    r.recordLeave(ctx, 'sess-X', 'w3-config')
    clock.advanceBy(30_000)
    const outcome = r.tryRecognizeRenewal('w3-config')
    expect(outcome).toMatchObject({ kind: 'renewed', oldSessionId: 'sess-X' })
    expect(r.vacatedCount()).toBe(0)
  })

  test('claim after TTL falls through to normal path', () => {
    const clock = new FakeClock()
    const { ctx } = buildSpyCtx()
    const r = new RenewalCoordinator(clock, 60_000)
    r.recordLeave(ctx, 'sess-X', 'w3-config')
    clock.advanceBy(60_001)
    expect(r.tryRecognizeRenewal('w3-config')).toEqual({ kind: 'normal' })
    expect(r.vacatedCount()).toBe(0)
  })

  test('claim for a name never vacated returns normal', () => {
    const clock = new FakeClock()
    const r = new RenewalCoordinator(clock, 60_000)
    expect(r.tryRecognizeRenewal('fresh-name')).toEqual({ kind: 'normal' })
  })

  test('unnamed leave does not seed the cache', () => {
    const clock = new FakeClock()
    const { ctx, events } = buildSpyCtx()
    const r = new RenewalCoordinator(clock, 60_000)
    r.recordLeave(ctx, 'sess-X', null)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'leave', displayName: null })
    expect(r.vacatedCount()).toBe(0)
  })

  test('same-name re-vacate replaces the prior entry (most recent wins)', () => {
    const clock = new FakeClock()
    const { ctx } = buildSpyCtx()
    const r = new RenewalCoordinator(clock, 60_000)
    r.recordLeave(ctx, 'sess-X', 'name')
    r.recordLeave(ctx, 'sess-Y', 'name')
    const outcome = r.tryRecognizeRenewal('name')
    expect(outcome).toMatchObject({ kind: 'renewed', oldSessionId: 'sess-Y' })
  })

  test('successful recognition cancels the TTL timer', () => {
    const clock = new FakeClock()
    const { ctx } = buildSpyCtx()
    const r = new RenewalCoordinator(clock, 60_000)
    r.recordLeave(ctx, 'sess-X', 'name')
    r.tryRecognizeRenewal('name')
    expect(clock.pendingCount()).toBe(0)
  })

  test('shutdown clears all pending timers and the cache', () => {
    const clock = new FakeClock()
    const { ctx } = buildSpyCtx()
    const r = new RenewalCoordinator(clock, 60_000)
    r.recordLeave(ctx, 'sess-X', 'name1')
    r.recordLeave(ctx, 'sess-Y', 'name2')
    r.shutdown()
    expect(clock.pendingCount()).toBe(0)
    expect(r.vacatedCount()).toBe(0)
  })

  test('rapid restart loop — each restart recognized as renewal', () => {
    const clock = new FakeClock()
    const { ctx } = buildSpyCtx()
    const r = new RenewalCoordinator(clock, 60_000)
    r.recordLeave(ctx, 'sess-X', 'name')
    expect(r.tryRecognizeRenewal('name')).toMatchObject({
      kind: 'renewed',
      oldSessionId: 'sess-X',
    })
    r.recordLeave(ctx, 'sess-A', 'name')
    expect(r.tryRecognizeRenewal('name')).toMatchObject({
      kind: 'renewed',
      oldSessionId: 'sess-A',
    })
  })
})

// ──────────────────────────────────────────────────────────────────
// Integration tests through the daemon RPC surface.
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

describe('renewal recognition (integration)', () => {
  test('renewal via register-with-name: leave + session_renewed (2 events)', async () => {
    const daemon = spawnTestDaemon({ vacatedTtlMs: 60_000 })
    try {
      const observer = await registerClient(daemon, PEER_OBSERVER, 'observer')
      const leaveP = observer.nextNotification('choros.presence')
      const x = await registerClient(daemon, PEER_X, 'w3-config')
      // X's join fires immediately; eat it from the observer's queue.
      // (registerClient awaits the RPC; the join broadcast is sync.)
      const xJoinP = observer.nextNotification('choros.presence')
      // X deregisters: leave fires immediately, then cache is seeded.
      await x.call('choros.deregister', { session_id: PEER_X })
      // The observer's first subscription captured X's leave.
      const leave = (await leaveP) as { event: string; session_id: string }
      expect(leave.event).toBe('join')
      expect(leave.session_id).toBe(PEER_X)
      const realLeave = (await xJoinP) as { event: string; session_id: string }
      expect(realLeave.event).toBe('leave')
      expect(realLeave.session_id).toBe(PEER_X)

      // New shim registers with the same display_name → renewal recognized.
      const renewedP = observer.nextNotification('choros.presence')
      await registerClient(daemon, PEER_A, 'w3-config')
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
    } finally {
      await daemon.stop()
    }
  })

  test('renewal via anonymous-register + set_display_name', async () => {
    const daemon = spawnTestDaemon({ vacatedTtlMs: 60_000 })
    try {
      const observer = await registerClient(daemon, PEER_OBSERVER, 'observer')
      const xJoinP = observer.nextNotification('choros.presence')
      const x = await registerClient(daemon, PEER_X, 'w3-config')
      await xJoinP

      const xLeaveP = observer.nextNotification('choros.presence')
      await x.call('choros.deregister', { session_id: PEER_X })
      const leave = (await xLeaveP) as { event: string }
      expect(leave.event).toBe('leave')

      // New shim registers anonymously, then claims the name.
      const aJoinP = observer.nextNotification('choros.presence')
      const a = await registerClient(daemon, PEER_A)
      const aJoin = (await aJoinP) as { event: string; session_id: string }
      expect(aJoin.event).toBe('join') // anonymous join is visible

      const renewedP = observer.nextNotification('choros.presence')
      await a.call('choros.set_display_name', {
        session_id: PEER_A,
        display_name: 'w3-config',
      })
      const renewed = (await renewedP) as {
        event: string
        old_session_id: string
        display_name: string
      }
      expect(renewed.event).toBe('session_renewed')
      expect(renewed.old_session_id).toBe(PEER_X)
      expect(renewed.display_name).toBe('w3-config')

      await observer.close()
    } finally {
      await daemon.stop()
    }
  })

  test('no recognition past TTL → normal LWW/rename path', async () => {
    // Tiny TTL so the test runs fast.
    const daemon = spawnTestDaemon({ vacatedTtlMs: 30 })
    try {
      const observer = await registerClient(daemon, PEER_OBSERVER, 'observer')
      const xJoinP = observer.nextNotification('choros.presence')
      const x = await registerClient(daemon, PEER_X, 'w3-config')
      await xJoinP

      const xLeaveP = observer.nextNotification('choros.presence')
      await x.call('choros.deregister', { session_id: PEER_X })
      await xLeaveP

      await new Promise(resolve => setTimeout(resolve, 80))

      // New shim claims the name AFTER the TTL expired.
      const joinP = observer.nextNotification('choros.presence')
      await registerClient(daemon, PEER_A, 'w3-config')
      const join = (await joinP) as { event: string; session_id: string }
      // Normal path emits `join` (NOT session_renewed).
      expect(join.event).toBe('join')
      expect(join.session_id).toBe(PEER_A)

      await observer.close()
    } finally {
      await daemon.stop()
    }
  })
})
