import { describe, expect, test } from 'bun:test'
import {
  classifyPeerHeartbeat,
  isLivePeer,
  LIVE_MAX_AGE_MS,
  recipientLiveness,
} from '../src/health.ts'
import { fakeContext } from './fakes/index.ts'

const STATE = '/state/choros'

describe('isLivePeer (v0.17 invariant)', () => {
  test('returns false when peer dir has no heartbeat', async () => {
    const ctx = fakeContext()
    expect(await isLivePeer(ctx, STATE, 'peer')).toBe(false)
  })

  test('returns false when heartbeat is unparseable', async () => {
    const ctx = fakeContext()
    await ctx.fs.writeFile(`${STATE}/peer/.heartbeat`, 'not json')
    expect(await isLivePeer(ctx, STATE, 'peer')).toBe(false)
  })

  test('returns false when heartbeat mtime is older than LIVE_MAX_AGE_MS', async () => {
    const ctx = fakeContext()
    ctx.proc.setPidAlive(42, true)
    await ctx.fs.writeFile(`${STATE}/peer/.heartbeat`, JSON.stringify({ pid: 42 }))
    ctx.clock.advance(LIVE_MAX_AGE_MS + 1)
    expect(await isLivePeer(ctx, STATE, 'peer')).toBe(false)
  })

  test('returns false when heartbeat is fresh but bun pid is dead', async () => {
    const ctx = fakeContext()
    await ctx.fs.writeFile(`${STATE}/peer/.heartbeat`, JSON.stringify({ pid: 42 }))
    ctx.proc.setPidAlive(42, false)
    expect(await isLivePeer(ctx, STATE, 'peer')).toBe(false)
  })

  test('returns true when heartbeat is fresh AND bun pid is alive', async () => {
    const ctx = fakeContext()
    ctx.proc.setPidAlive(42, true)
    await ctx.fs.writeFile(`${STATE}/peer/.heartbeat`, JSON.stringify({ pid: 42 }))
    expect(await isLivePeer(ctx, STATE, 'peer')).toBe(true)
  })

  test('returns false when heartbeat is missing the pid field', async () => {
    const ctx = fakeContext()
    await ctx.fs.writeFile(`${STATE}/peer/.heartbeat`, JSON.stringify({ ts: '2026' }))
    expect(await isLivePeer(ctx, STATE, 'peer')).toBe(false)
  })
})

describe('classifyPeerHeartbeat', () => {
  test('none when no heartbeat present', () => {
    expect(classifyPeerHeartbeat(undefined, false, undefined, false)).toBe('none')
  })

  test('dead when heartbeat is older than DEAD_AGE_MS', () => {
    expect(classifyPeerHeartbeat(600_001, false, undefined, true)).toBe('dead')
  })

  test('dead when bun pid not alive even if heartbeat is fresh (v0.17 fix)', () => {
    expect(classifyPeerHeartbeat(1000, false, undefined, false)).toBe('dead')
  })

  test('stale when heartbeat older than LIVE_MAX_AGE_MS but bun alive', () => {
    expect(classifyPeerHeartbeat(LIVE_MAX_AGE_MS + 1, false, undefined, true)).toBe('stale')
  })

  test('wedged when fresh+alive and .wedged present', () => {
    expect(classifyPeerHeartbeat(1000, true, undefined, true)).toBe('wedged')
  })

  test('paused when fresh+alive and agent-turn stale', () => {
    expect(classifyPeerHeartbeat(1000, false, LIVE_MAX_AGE_MS + 1, true)).toBe('paused')
  })

  test('live when fresh+alive and no wedge and agent-turn fresh', () => {
    expect(classifyPeerHeartbeat(1000, false, 1000, true)).toBe('live')
  })

  test('live when fresh+alive and agent-turn undefined', () => {
    expect(classifyPeerHeartbeat(1000, false, undefined, true)).toBe('live')
  })
})

describe('recipientLiveness', () => {
  test('unknown when peer has no heartbeat', async () => {
    const ctx = fakeContext()
    const r = await recipientLiveness(ctx, STATE, 'peer', undefined)
    expect(r.status).toBe('unknown')
  })

  test('stale when fresh heartbeat but bun pid is dead (v0.17 fix)', async () => {
    const ctx = fakeContext()
    await ctx.fs.writeFile(`${STATE}/peer/.heartbeat`, JSON.stringify({ pid: 42 }))
    ctx.proc.setPidAlive(42, false)
    const r = await recipientLiveness(ctx, STATE, 'peer', 0)
    expect(r.status).toBe('stale')
  })

  test('wedged when fresh+alive and .wedged present', async () => {
    const ctx = fakeContext()
    ctx.proc.setPidAlive(42, true)
    await ctx.fs.writeFile(`${STATE}/peer/.heartbeat`, JSON.stringify({ pid: 42 }))
    await ctx.fs.writeFile(
      `${STATE}/peer/.wedged`,
      JSON.stringify({ detected_at: '2026-05-19T00:00:00Z', pending_msg_ids: ['m1', 'm2'] }),
    )
    const r = await recipientLiveness(ctx, STATE, 'peer', 0)
    expect(r.status).toBe('wedged')
    expect(r.wedge_pending_msg_ids).toEqual(['m1', 'm2'])
  })

  test('live when fresh+alive and no wedge', async () => {
    const ctx = fakeContext()
    ctx.proc.setPidAlive(42, true)
    await ctx.fs.writeFile(`${STATE}/peer/.heartbeat`, JSON.stringify({ pid: 42 }))
    const r = await recipientLiveness(ctx, STATE, 'peer', 5_000)
    expect(r.status).toBe('live')
    expect(r.last_agent_turn_age_ms).toBe(5_000)
  })

  test('stale when heartbeat is just plain old (regardless of pid)', async () => {
    const ctx = fakeContext()
    ctx.proc.setPidAlive(42, true)
    await ctx.fs.writeFile(`${STATE}/peer/.heartbeat`, JSON.stringify({ pid: 42 }))
    ctx.clock.advance(LIVE_MAX_AGE_MS + 1)
    const r = await recipientLiveness(ctx, STATE, 'peer', 0)
    expect(r.status).toBe('stale')
  })
})
