import { describe, expect, test } from 'bun:test'
import { handleBroadcast } from '../src/tools/broadcast.ts'
import { handleDoctor } from '../src/tools/doctor.ts'
import { handlePublish } from '../src/tools/publish.ts'
import { handleReact } from '../src/tools/react.ts'
import { handleSend } from '../src/tools/send.ts'
import { handleSetIntent, handleSetStatus } from '../src/tools/set_state.ts'
import { handleSubscribe, handleUnsubscribe, listSubscribers } from '../src/tools/subscribe.ts'
import { fakeContext } from './fakes/index.ts'

const STATE = '/state/choros'
const PROJECTS = '/state/projects'
const ME = '11111111-1111-1111-1111-111111111111'
const MY_NAME = 'me'
const sendTargets = {
  stateRoot: STATE,
  projectsRoot: PROJECTS,
  me: ME,
  myName: MY_NAME,
  mySentDir: `${STATE}/${ME}/sent`,
}

async function seedLivePeer(ctx: ReturnType<typeof fakeContext>, id: string, pid: number) {
  await ctx.fs.mkdir(`${STATE}/${id}`, { recursive: true })
  await ctx.fs.writeFile(`${STATE}/${id}/.heartbeat`, JSON.stringify({ pid }))
  ctx.proc.setPidAlive(pid, true)
}

describe('handleSend', () => {
  test('rejects empty to/body', async () => {
    const ctx = fakeContext()
    await expect(handleSend(ctx, sendTargets, {})).rejects.toThrow(/"to" is required/)
    await expect(handleSend(ctx, sendTargets, { to: 'peer' })).rejects.toThrow(/"body" is required/)
  })

  test('writes payload into recipient inbox via atomicWrite, returns msg_id', async () => {
    const ctx = fakeContext()
    const r = await handleSend(ctx, sendTargets, { to: 'peer', body: 'hi' })
    expect(r.recipient_id).toBe('peer')
    expect(r.msg_id).toMatch(/^\d{8}T\d{6}\d{3}Z-/)
    expect(ctx.fs.existsSync(`${STATE}/peer/inbox/${r.msg_id}.json`)).toBe(true)
    expect(ctx.fs.existsSync(`${STATE}/${ME}/sent/${r.msg_id}.json`)).toBe(true)
  })

  test('refuses send-to-self', async () => {
    const ctx = fakeContext()
    await expect(handleSend(ctx, sendTargets, { to: ME, body: 'self' })).rejects.toThrow(
      /cannot send to self/,
    )
  })

  test('rejects over-large body', async () => {
    const ctx = fakeContext()
    await expect(
      handleSend(ctx, sendTargets, { to: 'peer', body: 'x'.repeat(64 * 1024 + 1) }),
    ).rejects.toThrow(/exceeds/)
  })

  test('threads speech-act tag into the payload', async () => {
    const ctx = fakeContext()
    const r = await handleSend(ctx, sendTargets, {
      to: 'peer',
      body: 'is it merged?',
      act: 'QUESTION',
    })
    const payload = JSON.parse(await ctx.fs.readFile(`${STATE}/peer/inbox/${r.msg_id}.json`))
    expect(payload.act).toBe('QUESTION')
  })

  test('rejects unknown speech-act value', async () => {
    const ctx = fakeContext()
    await expect(
      handleSend(ctx, sendTargets, { to: 'peer', body: 'hi', act: 'SHOUT' }),
    ).rejects.toThrow(/one of/)
  })
})

describe('handleReact', () => {
  const reactTargets = { stateRoot: STATE, me: ME, myName: MY_NAME }
  test('writes a .react ack into sender_acks/', async () => {
    const ctx = fakeContext()
    const sender = '22222222-2222-2222-2222-222222222222'
    const r = await handleReact(ctx, reactTargets, {
      msg_id: 'm1',
      emoji: '👍',
      from_session: sender,
    })
    expect(r.wrote_to).toBe(`${STATE}/${sender}/sent_acks/m1.${ME.slice(0, 8)}.react`)
    expect(ctx.fs.existsSync(r.wrote_to)).toBe(true)
  })

  test('refuses react-to-self', async () => {
    const ctx = fakeContext()
    await expect(
      handleReact(ctx, reactTargets, { msg_id: 'm1', emoji: '👍', from_session: ME }),
    ).rejects.toThrow(/from self/)
  })

  test('rejects path traversal in msg_id', async () => {
    const ctx = fakeContext()
    await expect(
      handleReact(ctx, reactTargets, { msg_id: '../etc', emoji: '👍', from_session: 'p' }),
    ).rejects.toThrow()
  })
})

describe('handleSetStatus / handleSetIntent', () => {
  const stateTargets = { agentStatePath: `${STATE}/${ME}/.agent_state` }

  test('set + clear status', async () => {
    const ctx = fakeContext()
    await handleSetStatus(ctx, stateTargets, 'working')
    const set = JSON.parse(await ctx.fs.readFile(stateTargets.agentStatePath))
    expect(set.status).toBe('working')
    await handleSetStatus(ctx, stateTargets, '')
    const cleared = JSON.parse(await ctx.fs.readFile(stateTargets.agentStatePath))
    expect(cleared.status).toBeUndefined()
  })

  test('intent is preserved when status is set', async () => {
    const ctx = fakeContext()
    await handleSetIntent(ctx, stateTargets, 'ship it')
    await handleSetStatus(ctx, stateTargets, 'working')
    const back = JSON.parse(await ctx.fs.readFile(stateTargets.agentStatePath))
    expect(back).toMatchObject({ status: 'working', intent: 'ship it' })
  })
})

describe('handleSubscribe / handleUnsubscribe', () => {
  const subTargets = { subscriptionsPath: `${STATE}/${ME}/.subscriptions` }

  test('subscribe adds the topic and persists', async () => {
    const ctx = fakeContext()
    const r = await handleSubscribe(ctx, subTargets, 'deploy-room')
    expect(r.subscribed).toEqual(['deploy-room'])
    expect(await listSubscribers(ctx, STATE, ME, 'deploy-room')).toBe(true)
  })

  test('unsubscribe removes it', async () => {
    const ctx = fakeContext()
    await handleSubscribe(ctx, subTargets, 't1')
    await handleSubscribe(ctx, subTargets, 't2')
    const r = await handleUnsubscribe(ctx, subTargets, 't1')
    expect(r.subscribed).toEqual(['t2'])
  })

  test('subscribe is idempotent', async () => {
    const ctx = fakeContext()
    await handleSubscribe(ctx, subTargets, 't1')
    const r = await handleSubscribe(ctx, subTargets, 't1')
    expect(r.subscribed).toEqual(['t1'])
  })

  test('rejects empty topic', async () => {
    const ctx = fakeContext()
    await expect(handleSubscribe(ctx, subTargets, '')).rejects.toThrow(/required/)
  })
})

describe('handleBroadcast', () => {
  test('writes one inbox per live peer; excludes self + dead', async () => {
    const ctx = fakeContext()
    const p1 = '22222222-2222-2222-2222-222222222222'
    const p2 = '33333333-3333-3333-3333-333333333333'
    const dead = '44444444-4444-4444-4444-444444444444'
    await seedLivePeer(ctx, p1, 9001)
    await seedLivePeer(ctx, p2, 9002)
    // Dead peer: fresh heartbeat, but pid is not alive
    await ctx.fs.mkdir(`${STATE}/${dead}`, { recursive: true })
    await ctx.fs.writeFile(`${STATE}/${dead}/.heartbeat`, JSON.stringify({ pid: 9999 }))
    ctx.proc.setPidAlive(9999, false)
    const r = await handleBroadcast(ctx, sendTargets, { body: 'hi' })
    expect(r.recipients.sort()).toEqual([p1, p2].sort())
    expect(ctx.fs.existsSync(`${STATE}/${p1}/inbox/${r.msg_id}.json`)).toBe(true)
    expect(ctx.fs.existsSync(`${STATE}/${p2}/inbox/${r.msg_id}.json`)).toBe(true)
    expect(ctx.fs.existsSync(`${STATE}/${dead}/inbox/${r.msg_id}.json`)).toBe(false)
    expect(ctx.fs.existsSync(`${STATE}/${ME}/inbox/${r.msg_id}.json`)).toBe(false)
  })

  test('rejects empty body', async () => {
    const ctx = fakeContext()
    await expect(handleBroadcast(ctx, sendTargets, {})).rejects.toThrow(/required/)
  })
})

describe('handlePublish', () => {
  test('writes inbox only for peers subscribed to the topic', async () => {
    const ctx = fakeContext()
    const p1 = '22222222-2222-2222-2222-222222222222'
    const p2 = '33333333-3333-3333-3333-333333333333'
    await seedLivePeer(ctx, p1, 9001)
    await seedLivePeer(ctx, p2, 9002)
    // Only p1 subscribed
    await ctx.fs.writeFile(`${STATE}/${p1}/.subscriptions`, JSON.stringify(['room-a']))
    const r = await handlePublish(ctx, sendTargets, { topic: 'room-a', body: 'hi' })
    expect(r.delivered_to).toEqual([p1])
    expect(ctx.fs.existsSync(`${STATE}/${p1}/inbox/${r.msg_id}.json`)).toBe(true)
    expect(ctx.fs.existsSync(`${STATE}/${p2}/inbox/${r.msg_id}.json`)).toBe(false)
  })

  test('skips self even if self is subscribed', async () => {
    const ctx = fakeContext()
    await ctx.fs.mkdir(`${STATE}/${ME}`, { recursive: true })
    await ctx.fs.writeFile(`${STATE}/${ME}/.subscriptions`, JSON.stringify(['room-a']))
    const r = await handlePublish(ctx, sendTargets, { topic: 'room-a', body: 'hi' })
    expect(r.delivered_to).toEqual([])
  })

  test('skips a peer that shares my display name (3-layer self-exclusion)', async () => {
    const ctx = fakeContext()
    const peerId = '99999999-9999-9999-9999-999999999999'
    await seedLivePeer(ctx, peerId, 12345)
    // Peer's JSONL has the same custom-title as us — name collision
    await ctx.fs.writeFile(
      `${PROJECTS}/-x/${peerId}.jsonl`,
      JSON.stringify({ type: 'custom-title', customTitle: MY_NAME }),
    )
    ctx.env.vars.PWD = '/x'
    await ctx.fs.writeFile(`${STATE}/${peerId}/.subscriptions`, JSON.stringify(['room-a']))
    const r = await handlePublish(ctx, sendTargets, { topic: 'room-a', body: 'hi' })
    expect(r.delivered_to).toEqual([])
  })
})

describe('handleDoctor', () => {
  const doctorTargets = {
    stateRoot: STATE,
    projectsRoot: PROJECTS,
    me: ME,
    myName: MY_NAME,
    inboxDir: `${STATE}/${ME}/inbox`,
  }

  test('reports self with inbox_unread count', async () => {
    const ctx = fakeContext()
    await ctx.fs.writeFile(`${STATE}/${ME}/inbox/m1.json`, '{}')
    await ctx.fs.writeFile(`${STATE}/${ME}/inbox/m2.json`, '{}')
    await ctx.fs.writeFile(`${STATE}/${ME}/inbox/m2.json.seen`, 'ok')
    const r = await handleDoctor(ctx, doctorTargets)
    expect(r.self.session_id).toBe(ME)
    expect(r.self.inbox_unread).toBe(2)
  })

  test('classifies peers correctly (live / dead-bun / stale)', async () => {
    const ctx = fakeContext()
    const liveId = '22222222-2222-2222-2222-222222222222'
    const ghostId = '33333333-3333-3333-3333-333333333333'
    await seedLivePeer(ctx, liveId, 9001)
    await ctx.fs.mkdir(`${STATE}/${ghostId}`, { recursive: true })
    await ctx.fs.writeFile(`${STATE}/${ghostId}/.heartbeat`, JSON.stringify({ pid: 9999 }))
    ctx.proc.setPidAlive(9999, false)
    const r = await handleDoctor(ctx, doctorTargets)
    const live = r.peers.find(p => p.session_id === liveId)
    const ghost = r.peers.find(p => p.session_id === ghostId)
    expect(live?.classification).toBe('live')
    expect(ghost?.classification).toBe('dead')
    expect(ghost?.bun_alive).toBe(false)
  })

  test('excludes self from peers list', async () => {
    const ctx = fakeContext()
    await ctx.fs.mkdir(`${STATE}/${ME}`, { recursive: true })
    await ctx.fs.writeFile(`${STATE}/${ME}/.heartbeat`, JSON.stringify({ pid: ctx.proc.pid() }))
    const r = await handleDoctor(ctx, doctorTargets)
    expect(r.peers.find(p => p.session_id === ME)).toBeUndefined()
  })
})
