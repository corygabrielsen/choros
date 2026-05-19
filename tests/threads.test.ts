import { describe, expect, test } from 'bun:test'
import {
  addMember,
  appendToThread,
  corruptMessagesIn,
  ensureThread,
  listMembers,
  listThreadsFor,
  readThread,
  removeMember,
} from '../src/threads.ts'
import {
  handleJoinThread,
  handleLeaveThread,
  handleListThreads,
  handleSendToThread,
} from '../src/tools/threads.ts'
import { fakeContext } from './fakes/index.ts'

const STATE = '/state/choros'
const ME = '11111111-1111-1111-1111-111111111111'
const PEER_A = '22222222-2222-2222-2222-222222222222'
const PEER_B = '33333333-3333-3333-3333-333333333333'
const tt = { stateRoot: STATE }
const targets = {
  stateRoot: STATE,
  me: ME,
  myName: 'me',
  mySentDir: `${STATE}/${ME}/sent`,
}

describe('thread storage', () => {
  test('ensureThread creates dirs + meta.json + empty members.json', async () => {
    const ctx = fakeContext()
    await ensureThread(ctx, tt, 'root-1', 'test thread')
    expect(ctx.fs.existsSync(`${STATE}/.threads/root-1/meta.json`)).toBe(true)
    expect(ctx.fs.existsSync(`${STATE}/.threads/root-1/members.json`)).toBe(true)
    const meta = JSON.parse(await ctx.fs.readFile(`${STATE}/.threads/root-1/meta.json`))
    expect(meta.root_msg_id).toBe('root-1')
    expect(meta.title).toBe('test thread')
  })

  test('ensureThread is idempotent — second call does not overwrite meta', async () => {
    const ctx = fakeContext()
    await ensureThread(ctx, tt, 'root-1', 'first')
    await ensureThread(ctx, tt, 'root-1', 'second')
    const meta = JSON.parse(await ctx.fs.readFile(`${STATE}/.threads/root-1/meta.json`))
    expect(meta.title).toBe('first')
  })

  test('appendToThread writes a per-message file atomically', async () => {
    const ctx = fakeContext()
    await appendToThread(ctx, tt, 'root-1', { id: 'm1', body: 'hi', ts: 'T1' })
    expect(ctx.fs.existsSync(`${STATE}/.threads/root-1/msgs/m1.json`)).toBe(true)
    const back = JSON.parse(await ctx.fs.readFile(`${STATE}/.threads/root-1/msgs/m1.json`))
    expect(back.id).toBe('m1')
  })

  test('readThread surfaces corrupt-msg count via corruptMessagesIn', async () => {
    const ctx = fakeContext()
    await appendToThread(ctx, tt, 'root-corrupt', { id: 'good', body: '', ts: 'T1' })
    // Manually write an unparseable msg file alongside the good one.
    await ctx.fs.writeFile(`${STATE}/.threads/root-corrupt/msgs/bad.json`, 'not json')
    const msgs = await readThread(ctx, tt, 'root-corrupt')
    expect(msgs.map(m => m.id)).toEqual(['good'])
    expect(corruptMessagesIn('root-corrupt')).toBe(1)
  })

  test('readThread returns messages sorted by ts', async () => {
    const ctx = fakeContext()
    await appendToThread(ctx, tt, 'root-1', { id: 'b', body: '2', ts: 'T2' })
    await appendToThread(ctx, tt, 'root-1', { id: 'a', body: '1', ts: 'T1' })
    await appendToThread(ctx, tt, 'root-1', { id: 'c', body: '3', ts: 'T3' })
    const msgs = await readThread(ctx, tt, 'root-1')
    expect(msgs.map(m => m.id)).toEqual(['a', 'b', 'c'])
  })

  test('addMember + listMembers + removeMember round-trip', async () => {
    const ctx = fakeContext()
    await addMember(ctx, tt, 'root-1', PEER_A)
    await addMember(ctx, tt, 'root-1', PEER_B)
    expect((await listMembers(ctx, tt, 'root-1')).sort()).toEqual([PEER_A, PEER_B].sort())
    await removeMember(ctx, tt, 'root-1', PEER_A)
    expect(await listMembers(ctx, tt, 'root-1')).toEqual([PEER_B])
  })

  test('concurrent addMember calls do not clobber each other', async () => {
    const ctx = fakeContext()
    // Fire many adds concurrently on the same thread — without per-thread
    // serialization, the read-modify-write sequence would lose updates.
    const ids = Array.from({ length: 10 }, (_, i) => `peer-${i}`)
    await Promise.all(ids.map(p => addMember(ctx, tt, 'root-x', p)))
    const members = await listMembers(ctx, tt, 'root-x')
    expect(members.sort()).toEqual(ids.sort())
  })
})

describe('handleJoinThread', () => {
  test('subscribes me and returns backlog', async () => {
    const ctx = fakeContext()
    await appendToThread(ctx, tt, 'root-1', { id: 'm1', body: 'past', ts: 'T1' })
    await appendToThread(ctx, tt, 'root-1', { id: 'm2', body: 'msg', ts: 'T2' })
    const r = await handleJoinThread(ctx, targets, 'root-1')
    expect(r.thread_id).toBe('root-1')
    expect(r.members).toContain(ME)
    expect(r.backlog.map(m => m.id)).toEqual(['m1', 'm2'])
  })

  test('rejects empty or unsafe thread_id', async () => {
    const ctx = fakeContext()
    await expect(handleJoinThread(ctx, targets, '')).rejects.toThrow(/required/)
    await expect(handleJoinThread(ctx, targets, '../etc')).rejects.toThrow()
  })
})

describe('handleSendToThread', () => {
  test('appends to thread and fans out to all members except self', async () => {
    const ctx = fakeContext()
    await addMember(ctx, tt, 'root-1', ME)
    await addMember(ctx, tt, 'root-1', PEER_A)
    await addMember(ctx, tt, 'root-1', PEER_B)
    const r = await handleSendToThread(ctx, targets, { thread_id: 'root-1', body: 'hello room' })
    expect(r.fanned_out_to.sort()).toEqual([PEER_A, PEER_B].sort())
    expect(ctx.fs.existsSync(`${STATE}/.threads/root-1/msgs/${r.msg_id}.json`)).toBe(true)
    expect(ctx.fs.existsSync(`${STATE}/${PEER_A}/inbox/${r.msg_id}.json`)).toBe(true)
    expect(ctx.fs.existsSync(`${STATE}/${PEER_B}/inbox/${r.msg_id}.json`)).toBe(true)
    expect(ctx.fs.existsSync(`${STATE}/${ME}/inbox/${r.msg_id}.json`)).toBe(false)
  })

  test('threads thread_id meta into recipient inbox payload', async () => {
    const ctx = fakeContext()
    await addMember(ctx, tt, 'root-1', ME)
    await addMember(ctx, tt, 'root-1', PEER_A)
    const r = await handleSendToThread(ctx, targets, {
      thread_id: 'root-1',
      body: 'hi',
      act: 'QUESTION',
    })
    const payload = JSON.parse(await ctx.fs.readFile(`${STATE}/${PEER_A}/inbox/${r.msg_id}.json`))
    expect(payload.thread_id).toBe('root-1')
    expect(payload.act).toBe('QUESTION')
  })

  test('auto-joins sender as a member', async () => {
    const ctx = fakeContext()
    await handleSendToThread(ctx, targets, { thread_id: 'root-1', body: 'first post' })
    expect(await listMembers(ctx, tt, 'root-1')).toContain(ME)
  })

  test('rejects empty / missing thread_id or body', async () => {
    const ctx = fakeContext()
    await expect(handleSendToThread(ctx, targets, { body: 'x' })).rejects.toThrow(/thread_id/)
    await expect(
      handleSendToThread(ctx, targets, { thread_id: 'root-1', body: '' }),
    ).rejects.toThrow(/body/)
  })
})

describe('handleLeaveThread', () => {
  test('removes me from the thread', async () => {
    const ctx = fakeContext()
    await addMember(ctx, tt, 'root-1', ME)
    await handleLeaveThread(ctx, targets, 'root-1')
    expect(await listMembers(ctx, tt, 'root-1')).not.toContain(ME)
  })
})

describe('handleListThreads', () => {
  test('shows only threads I am a member of, sorted by last_ts desc', async () => {
    const ctx = fakeContext()
    // Two threads. ME is in r1+r2. r2 has the newer message.
    await addMember(ctx, tt, 'r1', ME)
    await appendToThread(ctx, tt, 'r1', { id: 'a', body: '', ts: 'T2' })
    await addMember(ctx, tt, 'r2', ME)
    await appendToThread(ctx, tt, 'r2', { id: 'b', body: '', ts: 'T3' })
    // r3 has PEER_A only — should not appear
    await addMember(ctx, tt, 'r3', PEER_A)
    const out = await handleListThreads(ctx, { stateRoot: STATE, me: ME })
    expect(out.map(t => t.root_msg_id)).toEqual(['r2', 'r1'])
  })

  test('sort is deterministic when threads have no messages (tiebreaker)', async () => {
    const ctx = fakeContext()
    await addMember(ctx, tt, 'r-z', ME)
    await addMember(ctx, tt, 'r-a', ME)
    const out = await handleListThreads(ctx, { stateRoot: STATE, me: ME })
    // Both have no last_ts; tiebreaker is root_msg_id alphabetical
    expect(out.map(t => t.root_msg_id)).toEqual(['r-a', 'r-z'])
  })

  test('listThreadsFor returns message_count + member_count', async () => {
    const ctx = fakeContext()
    await addMember(ctx, tt, 'r1', ME)
    await addMember(ctx, tt, 'r1', PEER_A)
    await appendToThread(ctx, tt, 'r1', { id: 'a', body: '', ts: 'T1' })
    await appendToThread(ctx, tt, 'r1', { id: 'b', body: '', ts: 'T2' })
    const summaries = await listThreadsFor(ctx, tt, ME)
    expect(summaries[0]?.message_count).toBe(2)
    expect(summaries[0]?.member_count).toBe(2)
  })
})
