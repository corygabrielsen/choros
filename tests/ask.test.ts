import { describe, expect, test } from 'bun:test'
import { AskRegistry } from '../src/ask-registry.ts'
import { handleAsk } from '../src/tools/ask.ts'
import { fakeContext } from './fakes/index.ts'

const STATE = '/state/choros'
const PROJECTS = '/state/projects'
const ME = '11111111-1111-1111-1111-111111111111'
const targets = {
  stateRoot: STATE,
  projectsRoot: PROJECTS,
  me: ME,
  myName: 'me',
  mySentDir: `${STATE}/${ME}/sent`,
}

describe('AskRegistry', () => {
  test('notifyIfWaiting resolves the matching waiter exactly once', () => {
    const reg = new AskRegistry()
    const captured: { value: string | null } = { value: null }
    reg.register('q1', m => {
      captured.value = m.body ?? null
    })
    expect(reg.notifyIfWaiting({ id: 'r1', in_reply_to: 'q1', body: 'answer' })).toBe(true)
    expect(captured.value).toBe('answer')
    expect(reg.pendingCount()).toBe(0)
    // Second matching reply: no waiter to fire
    expect(reg.notifyIfWaiting({ id: 'r2', in_reply_to: 'q1', body: 'late' })).toBe(false)
  })

  test('ignores inbound without in_reply_to', () => {
    const reg = new AskRegistry()
    reg.register('q1', () => undefined)
    expect(reg.notifyIfWaiting({ id: 'r1', body: 'unrelated' })).toBe(false)
    expect(reg.pendingCount()).toBe(1)
  })

  test('unregister removes the waiter', () => {
    const reg = new AskRegistry()
    reg.register('q1', () => undefined)
    reg.unregister('q1')
    expect(reg.pendingCount()).toBe(0)
  })
})

describe('handleAsk', () => {
  test('happy path — reply arrives, ask resolves with answered status', async () => {
    const ctx = fakeContext()
    const reg = new AskRegistry()
    const askPromise = handleAsk(ctx, targets, reg, { to: 'peer', body: 'is X done?' })
    // Wait one tick so handleSend has written the question
    await new Promise(r => setTimeout(r, 5))
    const sentDir = `${STATE}/${ME}/sent`
    const entries = await ctx.fs.readdir(sentDir)
    const questionFile = entries.find(e => e.endsWith('.json'))
    expect(questionFile).toBeDefined()
    if (!questionFile) throw new Error('no question written')
    const question = JSON.parse(await ctx.fs.readFile(`${sentDir}/${questionFile}`))
    expect(question.act).toBe('QUESTION')
    // Simulate the peer's reply: the inbox watcher would call notifyIfWaiting
    reg.notifyIfWaiting({
      id: 'reply-1',
      in_reply_to: question.id,
      body: 'yes, shipped',
      from_session: 'peer',
      from_name: 'peer-name',
    })
    const r = await askPromise
    expect(r).toEqual({
      status: 'answered',
      reply_msg_id: 'reply-1',
      reply_body: 'yes, shipped',
      reply_from: 'peer-name',
    })
  })

  test('timeout path — no reply, ask resolves with timeout status', async () => {
    const ctx = fakeContext()
    const reg = new AskRegistry()
    const askPromise = handleAsk(ctx, targets, reg, {
      to: 'peer',
      body: 'will I be ignored?',
      timeout_ms: 100,
    })
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 5))
      ctx.clock.advance(50)
    }
    const r = await askPromise
    expect(r.status).toBe('timeout')
    if (r.status === 'timeout') {
      expect(r.question_msg_id).toMatch(/^\d{8}T\d{6}Z-/)
    }
  })

  test('rejects empty to / body', async () => {
    const ctx = fakeContext()
    const reg = new AskRegistry()
    await expect(handleAsk(ctx, targets, reg, { body: 'x' })).rejects.toThrow(/to/)
    await expect(handleAsk(ctx, targets, reg, { to: 'peer' })).rejects.toThrow(/body/)
  })

  test('rejects non-positive or non-numeric timeout_ms', async () => {
    const ctx = fakeContext()
    const reg = new AskRegistry()
    await expect(
      handleAsk(ctx, targets, reg, { to: 'peer', body: 'x', timeout_ms: 0 }),
    ).rejects.toThrow(/positive/)
    await expect(
      handleAsk(ctx, targets, reg, { to: 'peer', body: 'x', timeout_ms: -1 }),
    ).rejects.toThrow(/positive/)
  })

  test('callback throw does not unwind notifyIfWaiting', () => {
    const reg = new AskRegistry()
    reg.register('q', () => {
      throw new Error('boom')
    })
    expect(reg.notifyIfWaiting({ id: 'r', in_reply_to: 'q', body: '' })).toBe(true)
    expect(reg.pendingCount()).toBe(0)
  })

  test('refuses asking self', async () => {
    const ctx = fakeContext()
    const reg = new AskRegistry()
    await expect(handleAsk(ctx, targets, reg, { to: ME, body: 'me?' })).rejects.toThrow(
      /cannot send to self/,
    )
  })

  test('cleans registry after either outcome (no zombies)', async () => {
    const ctx = fakeContext()
    const reg = new AskRegistry()
    const p1 = handleAsk(ctx, targets, reg, { to: 'peer', body: 'q1', timeout_ms: 50 })
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 5))
      ctx.clock.advance(50)
    }
    await p1
    expect(reg.pendingCount()).toBe(0)
  })
})
