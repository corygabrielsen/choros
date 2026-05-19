import { describe, expect, test } from 'bun:test'
import {
  applyIntent,
  applyStatus,
  buildHeartbeat,
  readAgentState,
  writeAgentState,
  writeHeartbeat,
} from '#choros/heartbeat.ts'
import { FakeClock, fakeContext } from './fakes/index.ts'

describe('buildHeartbeat', () => {
  test('includes pid, ts, cwd at minimum', () => {
    const ctx = fakeContext({ clock: new FakeClock(1700_000_000_000) })
    const hb = buildHeartbeat(ctx, {})
    expect(hb.pid).toBe(ctx.proc.pid())
    expect(hb.cwd).toBe('/cwd')
    expect(hb.ts).toBe('2023-11-14T22:13:20.000Z')
    expect(hb.status).toBeUndefined()
    expect(hb.intent).toBeUndefined()
    expect(hb.last_user_prompt).toBeUndefined()
  })

  test('threads status/intent/timestamps when present', () => {
    const ctx = fakeContext()
    const hb = buildHeartbeat(
      ctx,
      { status: 'working', status_set_at: 'T1', intent: 'ship', intent_set_at: 'T2' },
      'hi',
    )
    expect(hb.status).toBe('working')
    expect(hb.status_set_at).toBe('T1')
    expect(hb.intent).toBe('ship')
    expect(hb.intent_set_at).toBe('T2')
    expect(hb.last_user_prompt).toBe('hi')
  })
})

describe('writeHeartbeat', () => {
  test('writes atomically via tmp+rename', async () => {
    const ctx = fakeContext()
    const path = '/state/peer/.heartbeat'
    const hb = buildHeartbeat(ctx, {})
    await writeHeartbeat(ctx, path, hb)
    expect(JSON.parse(await ctx.fs.readFile(path))).toMatchObject({ pid: ctx.proc.pid() })
    expect(ctx.fs.renamePairs.some(r => r.to === path)).toBe(true)
  })
})

describe('writeAgentState / readAgentState', () => {
  test('round-trips status + intent', async () => {
    const ctx = fakeContext()
    const path = '/state/.agent_state'
    await writeAgentState(ctx, path, {
      status: 's',
      status_set_at: 'T1',
      intent: 'i',
      intent_set_at: 'T2',
    })
    const back = await readAgentState(ctx, path)
    expect(back).toEqual({ status: 's', status_set_at: 'T1', intent: 'i', intent_set_at: 'T2' })
  })

  test('returns empty object when no file exists', async () => {
    const ctx = fakeContext()
    expect(await readAgentState(ctx, '/state/missing')).toEqual({})
  })
})

describe('applyStatus / applyIntent', () => {
  test('applyStatus sets text + timestamp, preserving intent', () => {
    const before = { intent: 'i', intent_set_at: 'T0' }
    const after = applyStatus(before, 'working', 'T1')
    expect(after).toEqual({
      intent: 'i',
      intent_set_at: 'T0',
      status: 'working',
      status_set_at: 'T1',
    })
  })

  test('applyStatus with empty text clears the status fields', () => {
    const before = { status: 'old', status_set_at: 'T0', intent: 'i' }
    const after = applyStatus(before, '', 'T1')
    expect(after).toEqual({ intent: 'i' })
  })

  test('applyIntent sets text + timestamp, preserving status', () => {
    const before = { status: 's' }
    const after = applyIntent(before, 'ship it', 'T1')
    expect(after).toEqual({ status: 's', intent: 'ship it', intent_set_at: 'T1' })
  })

  test('applyIntent with empty text clears the intent fields', () => {
    const before = { intent: 'old', intent_set_at: 'T0' }
    const after = applyIntent(before, '', 'T1')
    expect(after).toEqual({})
  })
})
