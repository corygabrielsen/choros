import { describe, expect, test } from 'bun:test'
import {
  broadcastPresence,
  broadcastRename,
  emitBootRoster,
  emitPresence,
  liveEligiblePeers,
  writePresence,
} from '../src/presence.ts'
import { fakeContext } from './fakes/index.ts'

const STATE = '/state/choros'
const PROJECTS = '/state/projects'
const ME = '11111111-1111-1111-1111-111111111111'
const MY_NAME = 'agent-tools'
const targets = { stateRoot: STATE, projectsRoot: PROJECTS, me: ME, myName: MY_NAME }

async function seedLivePeer(ctx: ReturnType<typeof fakeContext>, id: string, pid: number) {
  await ctx.fs.mkdir(`${STATE}/${id}`, { recursive: true })
  await ctx.fs.writeFile(`${STATE}/${id}/.heartbeat`, JSON.stringify({ pid }))
  ctx.proc.setPidAlive(pid, true)
}

async function seedDeadPeer(ctx: ReturnType<typeof fakeContext>, id: string, pid: number) {
  await ctx.fs.mkdir(`${STATE}/${id}`, { recursive: true })
  await ctx.fs.writeFile(`${STATE}/${id}/.heartbeat`, JSON.stringify({ pid }))
  ctx.proc.setPidAlive(pid, false)
}

describe('writePresence', () => {
  test('writes a .hello file via tmp+rename into the peer presence dir', async () => {
    const ctx = fakeContext()
    const peer = '22222222-2222-2222-2222-222222222222'
    await writePresence(ctx, targets, peer, 'hello')
    const dir = `${STATE}/${peer}/presence`
    const entries = await ctx.fs.readdir(dir)
    expect(entries.length).toBe(1)
    expect(entries[0]?.endsWith('.hello')).toBe(true)
    expect(ctx.fs.renamePairs.some(r => r.to.startsWith(dir))).toBe(true)
  })

  test('payload contains event=join and self peer_id', async () => {
    const ctx = fakeContext()
    const peer = '22222222-2222-2222-2222-222222222222'
    await writePresence(ctx, targets, peer, 'hello')
    const entries = await ctx.fs.readdir(`${STATE}/${peer}/presence`)
    const f = entries[0]
    if (!f) throw new Error('no entry')
    const payload = JSON.parse(await ctx.fs.readFile(`${STATE}/${peer}/presence/${f}`))
    expect(payload.event).toBe('join')
    expect(payload.peer_id).toBe(ME)
    expect(payload.peer_name).toBe(MY_NAME)
  })

  test('is a no-op when peerId equals self', async () => {
    const ctx = fakeContext()
    await writePresence(ctx, targets, ME, 'hello')
    expect(ctx.fs.renamePairs.length).toBe(0)
  })
})

describe('liveEligiblePeers (v0.17 invariant + 3-layer self-exclusion)', () => {
  test('includes live UUID peer with different name', async () => {
    const ctx = fakeContext()
    await seedLivePeer(ctx, '22222222-2222-2222-2222-222222222222', 9001)
    const peers = await liveEligiblePeers(ctx, targets)
    expect(peers.map(p => p.id)).toEqual(['22222222-2222-2222-2222-222222222222'])
  })

  test('excludes self by UUID (layer 1)', async () => {
    const ctx = fakeContext()
    await seedLivePeer(ctx, ME, 9001)
    const peers = await liveEligiblePeers(ctx, targets)
    expect(peers).toEqual([])
  })

  test('excludes by display name (layer 2)', async () => {
    const ctx = fakeContext()
    const peerId = '33333333-3333-3333-3333-333333333333'
    await seedLivePeer(ctx, peerId, 9001)
    // Give peer the same custom-title as us so name-match self-excludes them
    await ctx.fs.writeFile(
      `${PROJECTS}/-x/${peerId}.jsonl`,
      JSON.stringify({ type: 'custom-title', customTitle: MY_NAME }),
    )
    ctx.env.vars.PWD = '/x'
    const peers = await liveEligiblePeers(ctx, targets)
    expect(peers).toEqual([])
  })

  test('excludes by heartbeat pid (layer 3)', async () => {
    const ctx = fakeContext()
    await ctx.fs.mkdir(`${STATE}/sibling`, { recursive: true })
    await ctx.fs.writeFile(`${STATE}/sibling/.heartbeat`, JSON.stringify({ pid: ctx.proc.pid() }))
    ctx.proc.setPidAlive(ctx.proc.pid(), true)
    const peers = await liveEligiblePeers(ctx, targets)
    expect(peers).toEqual([])
  })

  test('excludes a dead-bun peer with fresh heartbeat (v0.17 fix)', async () => {
    const ctx = fakeContext()
    await seedDeadPeer(ctx, '44444444-4444-4444-4444-444444444444', 9999)
    const peers = await liveEligiblePeers(ctx, targets)
    expect(peers).toEqual([])
  })
})

describe('broadcastPresence', () => {
  test('writes a hello to every live peer and returns the list', async () => {
    const ctx = fakeContext()
    const p1 = '22222222-2222-2222-2222-222222222222'
    const p2 = '33333333-3333-3333-3333-333333333333'
    await seedLivePeer(ctx, p1, 9001)
    await seedLivePeer(ctx, p2, 9002)
    const peers = await broadcastPresence(ctx, targets, 'hello')
    expect(peers.map(p => p.id).sort()).toEqual([p1, p2].sort())
    expect((await ctx.fs.readdir(`${STATE}/${p1}/presence`)).length).toBe(1)
    expect((await ctx.fs.readdir(`${STATE}/${p2}/presence`)).length).toBe(1)
  })

  test('skips dead-bun peers (v0.17 invariant)', async () => {
    const ctx = fakeContext()
    const dead = '44444444-4444-4444-4444-444444444444'
    await seedDeadPeer(ctx, dead, 9999)
    const peers = await broadcastPresence(ctx, targets, 'hello')
    expect(peers).toEqual([])
    // Dead peer's presence dir should remain empty
    const entries = await ctx.fs.readdir(`${STATE}/${dead}`).catch(() => [])
    expect(entries.includes('presence')).toBe(false)
  })
})

describe('emitBootRoster', () => {
  test('no-op when peer list is empty', async () => {
    const ctx = fakeContext()
    await emitBootRoster(ctx, { wedgePath: `${STATE}/${ME}/.wedged`, peers: [] })
    expect(ctx.mcp.notifications.length).toBe(0)
  })

  test('emits one channel notification listing all peers, sorted', async () => {
    const ctx = fakeContext()
    await emitBootRoster(ctx, {
      wedgePath: `${STATE}/${ME}/.wedged`,
      peers: [
        { id: '22222222-2222-2222-2222-222222222222', name: 'bob' },
        { id: '33333333-3333-3333-3333-333333333333', name: 'alice' },
      ],
    })
    expect(ctx.mcp.notifications.length).toBe(1)
    const n = ctx.mcp.notifications[0]
    expect(n?.method).toBe('notifications/claude/channel')
    const params = n?.params as { content: string; meta: Record<string, string> }
    expect(params.content).toBe('Other agents online: alice, bob')
    expect(params.meta.event).toBe('roster')
    expect(params.meta.count).toBe('2')
  })
})

describe('emitPresence (own presence dir consumer)', () => {
  test('emits join channel event for a .hello and unlinks the file', async () => {
    const ctx = fakeContext()
    const dir = `${STATE}/${ME}/presence`
    const filename = '20260519T000000Z-22222222.hello'
    await ctx.fs.writeFile(
      `${dir}/${filename}`,
      JSON.stringify({ event: 'join', peer_id: '22222222', peer_name: 'bob' }),
    )
    const r = await emitPresence(ctx, dir, ME, filename)
    expect(r).toBe('emitted')
    expect(ctx.mcp.notifications.length).toBe(1)
    expect(ctx.fs.existsSync(`${dir}/${filename}`)).toBe(false)
  })

  test('unlinks a self-presence file without emitting', async () => {
    const ctx = fakeContext()
    const dir = `${STATE}/${ME}/presence`
    const filename = '20260519T000000Z-self.hello'
    await ctx.fs.writeFile(`${dir}/${filename}`, JSON.stringify({ event: 'join', peer_id: ME }))
    const r = await emitPresence(ctx, dir, ME, filename)
    expect(r).toBe('self')
    expect(ctx.mcp.notifications.length).toBe(0)
    expect(ctx.fs.existsSync(`${dir}/${filename}`)).toBe(false)
  })

  test('unlinks file even when push times out (presence is fire-and-forget)', async () => {
    const ctx = fakeContext()
    ctx.mcp.hangForever = true
    const dir = `${STATE}/${ME}/presence`
    const filename = '20260519T000000Z-22222222.hello'
    await ctx.fs.writeFile(
      `${dir}/${filename}`,
      JSON.stringify({ event: 'join', peer_id: '22222222', peer_name: 'bob' }),
    )
    const running = emitPresence(ctx, dir, ME, filename)
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 5))
      ctx.clock.advance(2000)
    }
    expect(await running).toBe('timeout')
    // File is dropped even on timeout — otherwise the dir grows forever
    // under a wedged CC. A missed presence event is acceptable.
    expect(ctx.fs.existsSync(`${dir}/${filename}`)).toBe(false)
  })

  test('skips non-presence filenames (.tmp, dotfiles)', async () => {
    const ctx = fakeContext()
    const dir = `${STATE}/${ME}/presence`
    expect(await emitPresence(ctx, dir, ME, '.in-progress.tmp')).toBe('skipped')
    expect(await emitPresence(ctx, dir, ME, 'random.txt')).toBe('skipped')
  })

  test('emits rename event with old_name / new_name in meta', async () => {
    const ctx = fakeContext()
    const dir = `${STATE}/${ME}/presence`
    const filename = '20260519T010000Z-22222222.rename'
    await ctx.fs.writeFile(
      `${dir}/${filename}`,
      JSON.stringify({
        event: 'rename',
        peer_id: '22222222',
        peer_name: 'new-name',
        old_name: 'old-name',
        new_name: 'new-name',
      }),
    )
    const r = await emitPresence(ctx, dir, ME, filename)
    expect(r).toBe('emitted')
    const params = ctx.mcp.notifications[0]?.params as {
      content: string
      meta: Record<string, string>
    }
    expect(params.content).toBe('Peer old-name renamed to new-name')
    expect(params.meta.event).toBe('rename')
    expect(params.meta.old_name).toBe('old-name')
    expect(params.meta.new_name).toBe('new-name')
  })
})

describe('broadcastRename', () => {
  test('writes a .rename to every live peer with old+new fields', async () => {
    const ctx = fakeContext()
    const p1 = '22222222-2222-2222-2222-222222222222'
    const p2 = '33333333-3333-3333-3333-333333333333'
    await seedLivePeer(ctx, p1, 9001)
    await seedLivePeer(ctx, p2, 9002)
    const peers = await broadcastRename(ctx, targets, 'old-name', 'new-name')
    expect(peers.map(p => p.id).sort()).toEqual([p1, p2].sort())
    for (const p of peers) {
      const dir = `${STATE}/${p.id}/presence`
      const entries = await ctx.fs.readdir(dir)
      const renameFile = entries.find(e => e.endsWith('.rename'))
      expect(renameFile).toBeDefined()
      if (!renameFile) continue
      const payload = JSON.parse(await ctx.fs.readFile(`${dir}/${renameFile}`))
      expect(payload.event).toBe('rename')
      expect(payload.old_name).toBe('old-name')
      expect(payload.new_name).toBe('new-name')
    }
  })

  test('skips dead-bun peers (v0.17 invariant carries through)', async () => {
    const ctx = fakeContext()
    const dead = '44444444-4444-4444-4444-444444444444'
    await seedDeadPeer(ctx, dead, 9999)
    const peers = await broadcastRename(ctx, targets, 'a', 'b')
    expect(peers).toEqual([])
  })
})
