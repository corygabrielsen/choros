import { describe, expect, test } from 'bun:test'
import {
  BODY_CAP_BYTES,
  archiveInboxMessage,
  emitInboxMessage,
  enforceBodyCap,
  readInboxMessage,
  validateReplyBudget,
} from '../src/inbox.ts'
import { fakeContext } from './fakes/index.ts'

const STATE = '/state/choros'
const PROJECTS = '/state/projects'
const ME = '11111111-1111-1111-1111-111111111111'
const MY_NAME = 'me'

function setup() {
  const ctx = fakeContext()
  const targets = {
    stateRoot: STATE,
    projectsRoot: PROJECTS,
    me: ME,
    myName: MY_NAME,
    wedgePath: `${STATE}/${ME}/.wedged`,
    inboxDir: `${STATE}/${ME}/inbox`,
    readDir: `${STATE}/${ME}/inbox/read`,
  }
  return { ctx, targets, wedge: { consecutiveTimeouts: 0 }, emittedDropped: new Set<string>() }
}

describe('readInboxMessage', () => {
  test('returns parsed message', async () => {
    const { ctx } = setup()
    await ctx.fs.writeFile('/state/m.json', JSON.stringify({ id: 'm1', body: 'hi' }))
    expect(await readInboxMessage(ctx, '/state/m.json')).toEqual({ id: 'm1', body: 'hi' })
  })

  test('returns null on missing file', async () => {
    const { ctx } = setup()
    expect(await readInboxMessage(ctx, '/state/missing.json')).toBeNull()
  })

  test('returns null and logs on unparseable JSON', async () => {
    const { ctx } = setup()
    await ctx.fs.writeFile('/state/bad.json', 'not json')
    expect(await readInboxMessage(ctx, '/state/bad.json')).toBeNull()
    expect(ctx.proc.stderrLines.join('')).toContain('failed to parse')
  })
})

describe('enforceBodyCap', () => {
  test('accepts body under the cap', () => {
    expect(() => enforceBodyCap('x'.repeat(BODY_CAP_BYTES), 'send')).not.toThrow()
  })

  test('rejects body over the cap', () => {
    expect(() => enforceBodyCap('x'.repeat(BODY_CAP_BYTES + 1), 'send')).toThrow(/exceeds/)
  })

  test('counts UTF-8 bytes, not codepoints', () => {
    const big = '😀'.repeat(BODY_CAP_BYTES / 4 + 1)
    expect(() => enforceBodyCap(big, 'send')).toThrow()
  })
})

describe('validateReplyBudget', () => {
  test('accepts undefined and null', () => {
    expect(validateReplyBudget(undefined)).toBeUndefined()
    expect(validateReplyBudget(null)).toBeUndefined()
  })

  test('accepts non-negative integers', () => {
    expect(validateReplyBudget(0)).toBe(0)
    expect(validateReplyBudget(5)).toBe(5)
  })

  test('rejects negatives, fractions, NaN, infinity, strings', () => {
    expect(() => validateReplyBudget(-1)).toThrow()
    expect(() => validateReplyBudget(1.5)).toThrow()
    expect(() => validateReplyBudget(Number.NaN)).toThrow()
    expect(() => validateReplyBudget(Number.POSITIVE_INFINITY)).toThrow()
    expect(() => validateReplyBudget('1')).toThrow()
  })
})

describe('emitInboxMessage', () => {
  test('emits channel event, writes .seen, writes .ack to sender', async () => {
    const { ctx, targets, wedge, emittedDropped } = setup()
    const sender = '22222222-2222-2222-2222-222222222222'
    // Self JSONL — verifyJsonlReceipt returns true optimistically when null;
    // we set the path to null effectively by leaving projectsRoot empty.
    const filename = 'm1.json'
    await ctx.fs.writeFile(
      `${targets.inboxDir}/${filename}`,
      JSON.stringify({ id: 'm1', body: 'hi', from_session: sender, ts: 'T' }),
    )
    const r = await emitInboxMessage(ctx, targets, wedge, emittedDropped, filename)
    expect(r.status).toBe('emitted')
    expect(ctx.fs.existsSync(`${targets.inboxDir}/${filename}.seen`)).toBe(true)
    expect(ctx.fs.existsSync(`${STATE}/${sender}/sent_acks/m1.ack`)).toBe(true)
  })

  test('skips when .seen sidecar already present', async () => {
    const { ctx, targets, wedge, emittedDropped } = setup()
    const filename = 'm1.json'
    await ctx.fs.writeFile(`${targets.inboxDir}/${filename}`, JSON.stringify({ id: 'm1' }))
    await ctx.fs.writeFile(`${targets.inboxDir}/${filename}.seen`, 'already')
    const r = await emitInboxMessage(ctx, targets, wedge, emittedDropped, filename)
    expect(r.status).toBe('skipped')
    expect(ctx.mcp.notifications.length).toBe(0)
  })

  test('writes .dropped to sender on JSONL verify miss (dedup-aware)', async () => {
    const { ctx, targets, wedge, emittedDropped } = setup()
    const sender = '22222222-2222-2222-2222-222222222222'
    const filename = 'm1.json'
    // Seed CC JSONL with a pre-existing line that does NOT contain msg-1 in
    // appended bytes — so verifyJsonlReceipt's append-only window will miss.
    await ctx.fs.writeFile(`${PROJECTS}/-cwd/${ME}.jsonl`, '{"unrelated":true}\n')
    ctx.env.vars.PWD = '/cwd'
    await ctx.fs.writeFile(
      `${targets.inboxDir}/${filename}`,
      JSON.stringify({ id: 'm1', body: 'hi', from_session: sender, ts: 'T' }),
    )
    const running = emitInboxMessage(ctx, targets, wedge, emittedDropped, filename)
    // Advance virtual clock past the JSONL verify timeout
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 5))
      ctx.clock.advance(300)
    }
    const r = await running
    expect(r.status).toBe('dropped')
    expect(ctx.fs.existsSync(`${STATE}/${sender}/sent_acks/m1.dropped`)).toBe(true)
    expect(emittedDropped.has('m1')).toBe(true)
  })

  test('mentioned_me=true when sender mentions us', async () => {
    const { ctx, targets, wedge, emittedDropped } = setup()
    const filename = 'm1.json'
    await ctx.fs.writeFile(
      `${targets.inboxDir}/${filename}`,
      JSON.stringify({
        id: 'm1',
        body: 'hey @me',
        from_session: '22222222-2222-2222-2222-222222222222',
        mentions: [ME],
      }),
    )
    await emitInboxMessage(ctx, targets, wedge, emittedDropped, filename)
    const notification = ctx.mcp.notifications[0]
    const params = notification?.params as { meta?: Record<string, string> }
    expect(params?.meta?.mentioned_me).toBe('true')
  })
})

describe('archiveInboxMessage', () => {
  test('moves the .json into read/ and unlinks the .seen', async () => {
    const { ctx, targets } = setup()
    const filename = 'm1.json'
    await ctx.fs.writeFile(`${targets.inboxDir}/${filename}`, JSON.stringify({ id: 'm1' }))
    await ctx.fs.writeFile(`${targets.inboxDir}/${filename}.seen`, 'ok')
    await archiveInboxMessage(ctx, targets, filename)
    expect(ctx.fs.existsSync(`${targets.readDir}/${filename}`)).toBe(true)
    expect(ctx.fs.existsSync(`${targets.inboxDir}/${filename}`)).toBe(false)
    expect(ctx.fs.existsSync(`${targets.inboxDir}/${filename}.seen`)).toBe(false)
  })
})
