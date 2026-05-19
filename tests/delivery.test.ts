import { describe, expect, test } from 'bun:test'
import {
  atomicWrite,
  pushChannelNotification,
  verifyJsonlReceipt,
  WEDGE_TIMEOUT_THRESHOLD,
  withTimeout,
  writeAckToSender,
} from '../src/delivery.ts'
import { FakeClock, FakeMcp, FakeProc, fakeContext } from './fakes/index.ts'

const STATE = '/state/choros'
const ME = '11111111-1111-1111-1111-111111111111'
const MY_NAME = 'me'
const WEDGE = `${STATE}/${ME}/.wedged`

describe('withTimeout', () => {
  test("returns 'ok' for a resolved promise", async () => {
    const ctx = fakeContext()
    const r = await withTimeout(ctx, Promise.resolve(undefined), 1000, 'test')
    expect(r).toBe('ok')
  })

  test("returns 'timeout' for a hanging promise (EPIPE simulation)", async () => {
    const ctx = fakeContext()
    const hanging = new Promise<void>(() => undefined)
    const racing = withTimeout(ctx, hanging, 100, 'test')
    ctx.clock.advance(101)
    expect(await racing).toBe('timeout')
  })

  test("treats rejection as 'ok' but logs to stderr", async () => {
    const ctx = fakeContext()
    const r = await withTimeout(ctx, Promise.reject(new Error('boom')), 1000, 'test')
    expect(r).toBe('ok')
    expect(ctx.proc.stderrLines.join('')).toContain('rejected: boom')
  })

  test('clears timer on resolve — no zombie timers', async () => {
    const clock = new FakeClock()
    const ctx = fakeContext({ clock })
    await withTimeout(ctx, Promise.resolve(undefined), 1000, 'test')
    expect(clock.pendingTimers()).toBe(0)
  })

  test('clears timer on timeout', async () => {
    const clock = new FakeClock()
    const ctx = fakeContext({ clock })
    const racing = withTimeout(ctx, new Promise<void>(() => undefined), 100, 'test')
    clock.advance(101)
    await racing
    expect(clock.pendingTimers()).toBe(0)
  })
})

describe('atomicWrite', () => {
  test('writes via tmp+rename (atomicity witness)', async () => {
    const ctx = fakeContext()
    await atomicWrite(ctx, '/state/foo', 'payload')
    expect(await ctx.fs.readFile('/state/foo')).toBe('payload')
    expect(ctx.fs.renamePairs.length).toBe(1)
    expect(ctx.fs.renamePairs[0]?.to).toBe('/state/foo')
    expect(ctx.fs.renamePairs[0]?.from).toContain('.tmp')
  })

  test('tmp file includes pid AND a monotonic counter (no collisions)', async () => {
    const ctx = fakeContext()
    await atomicWrite(ctx, '/state/foo', 'a')
    await atomicWrite(ctx, '/state/bar', 'b')
    const tmpA = ctx.fs.renamePairs[0]?.from
    const tmpB = ctx.fs.renamePairs[1]?.from
    expect(tmpA).toMatch(new RegExp(`^/state/foo\\.${ctx.proc.pid()}\\.\\d+\\.tmp$`))
    expect(tmpB).toMatch(new RegExp(`^/state/bar\\.${ctx.proc.pid()}\\.\\d+\\.tmp$`))
    expect(tmpA).not.toBe(tmpB)
  })
})

describe('verifyJsonlReceipt (append-only window)', () => {
  test('returns true optimistically when no jsonl exists', async () => {
    const ctx = fakeContext()
    expect(await verifyJsonlReceipt(ctx, null, 'msg-1', 0, 100)).toBe(true)
  })

  // Note: the "finds msg_id in appended bytes" positive case is exercised
  // by the inbox emit integration test, which drives verifyJsonlReceipt
  // through emitInboxMessage. We intentionally don't try to test it here
  // in isolation — the only way would be mixing real setTimeout (for the
  // write) with virtual ctx.clock.advance (for the poll), which produces
  // a false-confidence race.

  test('rejects substring matches in bytes that existed before the probe', async () => {
    const ctx = fakeContext()
    const jsonl = '/state/jsonl'
    await ctx.fs.writeFile(jsonl, '{"older":"event","msg_id":"msg-1"}\n')
    const startSize = (await ctx.fs.stat(jsonl)).size
    const probe = verifyJsonlReceipt(ctx, jsonl, 'msg-1', startSize, 100)
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 5))
      ctx.clock.advance(50)
    }
    expect(await probe).toBe(false)
  })

  test('returns false after timeout when msg_id never appears', async () => {
    const ctx = fakeContext()
    const jsonl = '/state/jsonl'
    await ctx.fs.writeFile(jsonl, 'irrelevant\n')
    const startSize = (await ctx.fs.stat(jsonl)).size
    const probe = verifyJsonlReceipt(ctx, jsonl, 'msg-1', startSize, 100)
    // Tick virtual clock past deadline
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 5))
      ctx.clock.advance(50)
    }
    expect(await probe).toBe(false)
  })
})

describe('pushChannelNotification (wedge bookkeeping)', () => {
  function setup() {
    const clock = new FakeClock()
    const proc = new FakeProc()
    const mcp = new FakeMcp()
    const ctx = fakeContext({ clock, proc, mcp })
    return { ctx, clock, proc, mcp, state: { consecutiveTimeouts: 0 } }
  }

  test("resolves to 'ok' and notification is recorded", async () => {
    const { ctx, state } = setup()
    const r = await pushChannelNotification(ctx, state, WEDGE, 'm1', 'body', { source: 'choros' })
    expect(r).toBe('ok')
    expect(state.consecutiveTimeouts).toBe(0)
    expect(ctx.mcp.notifications.length).toBe(1)
  })

  test('timeout increments consecutiveTimeouts', async () => {
    const { ctx, clock, mcp, state } = setup()
    mcp.hangForever = true
    const racing = pushChannelNotification(ctx, state, WEDGE, 'm1', 'body', { source: 'choros' })
    clock.advance(6000)
    expect(await racing).toBe('timeout')
    expect(state.consecutiveTimeouts).toBe(1)
  })

  test(`writes .wedged after ${WEDGE_TIMEOUT_THRESHOLD} consecutive timeouts`, async () => {
    const { ctx, clock, mcp, state } = setup()
    mcp.hangForever = true
    for (let i = 0; i < WEDGE_TIMEOUT_THRESHOLD; i++) {
      const racing = pushChannelNotification(ctx, state, WEDGE, `m${i}`, 'body', {
        source: 'choros',
      })
      clock.advance(6000)
      await racing
    }
    expect(state.consecutiveTimeouts).toBe(WEDGE_TIMEOUT_THRESHOLD)
    expect(ctx.fs.existsSync(WEDGE)).toBe(true)
  })

  test('successful push clears the wedge marker', async () => {
    const { ctx, clock, mcp, state } = setup()
    // Hang to set wedge
    mcp.hangForever = true
    for (let i = 0; i < WEDGE_TIMEOUT_THRESHOLD; i++) {
      const r = pushChannelNotification(ctx, state, WEDGE, `m${i}`, 'b', { source: 'choros' })
      clock.advance(6000)
      await r
    }
    expect(ctx.fs.existsSync(WEDGE)).toBe(true)
    // Recover
    mcp.hangForever = false
    await pushChannelNotification(ctx, state, WEDGE, 'recover', 'b', { source: 'choros' })
    expect(state.consecutiveTimeouts).toBe(0)
    expect(ctx.fs.existsSync(WEDGE)).toBe(false)
  })
})

describe('writeAckToSender', () => {
  const SENDER = '22222222-2222-2222-2222-222222222222'

  test('writes .ack to sender_acks/ on delivered status', async () => {
    const ctx = fakeContext()
    const r = await writeAckToSender(
      ctx,
      { stateRoot: STATE, me: ME, myName: MY_NAME },
      { from_session: SENDER, id: 'm1' },
      'delivered',
      ctx.proc.pid(),
    )
    expect(r).toBe('written')
    expect(ctx.fs.existsSync(`${STATE}/${SENDER}/sent_acks/m1.ack`)).toBe(true)
  })

  test('writes .dropped on dropped status', async () => {
    const ctx = fakeContext()
    await writeAckToSender(
      ctx,
      { stateRoot: STATE, me: ME, myName: MY_NAME },
      { from_session: SENDER, id: 'm1' },
      'dropped',
      ctx.proc.pid(),
    )
    expect(ctx.fs.existsSync(`${STATE}/${SENDER}/sent_acks/m1.dropped`)).toBe(true)
  })

  test('idempotent: second write for same msg_id is skipped (dedup)', async () => {
    const ctx = fakeContext()
    await writeAckToSender(
      ctx,
      { stateRoot: STATE, me: ME, myName: MY_NAME },
      { from_session: SENDER, id: 'm1' },
      'dropped',
      ctx.proc.pid(),
    )
    const second = await writeAckToSender(
      ctx,
      { stateRoot: STATE, me: ME, myName: MY_NAME },
      { from_session: SENDER, id: 'm1' },
      'dropped',
      ctx.proc.pid(),
    )
    expect(second).toBe('skipped')
  })

  test('cross-status dedup: a .ack blocks a future .dropped', async () => {
    const ctx = fakeContext()
    await writeAckToSender(
      ctx,
      { stateRoot: STATE, me: ME, myName: MY_NAME },
      { from_session: SENDER, id: 'm1' },
      'delivered',
      ctx.proc.pid(),
    )
    const drop = await writeAckToSender(
      ctx,
      { stateRoot: STATE, me: ME, myName: MY_NAME },
      { from_session: SENDER, id: 'm1' },
      'dropped',
      ctx.proc.pid(),
    )
    expect(drop).toBe('skipped')
  })

  test('refuses self-ack (from_session === me)', async () => {
    const ctx = fakeContext()
    const r = await writeAckToSender(
      ctx,
      { stateRoot: STATE, me: ME, myName: MY_NAME },
      { from_session: ME, id: 'm1' },
      'delivered',
      ctx.proc.pid(),
    )
    expect(r).toBe('skipped')
  })

  test('skips when from_session or id is empty', async () => {
    const ctx = fakeContext()
    expect(
      await writeAckToSender(
        ctx,
        { stateRoot: STATE, me: ME, myName: MY_NAME },
        { from_session: '', id: 'm1' },
        'delivered',
        ctx.proc.pid(),
      ),
    ).toBe('skipped')
    expect(
      await writeAckToSender(
        ctx,
        { stateRoot: STATE, me: ME, myName: MY_NAME },
        { from_session: SENDER, id: '' },
        'delivered',
        ctx.proc.pid(),
      ),
    ).toBe('skipped')
  })
})
