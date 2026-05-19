import { join } from 'node:path'
import { PUSH_TIMEOUT_MS, atomicWrite, withTimeout } from './delivery.ts'
import type { Context } from './effects.ts'
import { isLivePeer } from './health.ts'
import { type KnownInstance, isSelf, listKnownInstances } from './identity.ts'

export interface PresenceTargets {
  stateRoot: string
  projectsRoot: string
  me: string
  myName: string
}

export interface LivePeer {
  id: string
  name: string | null
}

export type PresenceKind = 'hello' | 'goodbye' | 'rename'

/** Drop a `.hello` / `.goodbye` / `.rename` file into a peer's `presence/`
 *  dir. Uses atomicWrite — a peer's inotify watcher won't see a half-written
 *  payload. */
export async function writePresence(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc' | 'env'>,
  targets: PresenceTargets,
  peerId: string,
  kind: PresenceKind,
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (peerId === targets.me) return
  const peerPresenceDir = join(targets.stateRoot, peerId, 'presence')
  await ctx.fs.mkdir(peerPresenceDir, { recursive: true })
  const tsId = ctx.clock
    .nowIso()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  const path = join(peerPresenceDir, `${tsId}-${targets.me.slice(0, 8)}.${kind}`)
  const eventMap = { hello: 'join', goodbye: 'leave', rename: 'rename' } as const
  const payload = JSON.stringify({
    event: eventMap[kind],
    peer_id: targets.me,
    peer_name: targets.myName,
    peer_host: ctx.env.hostname(),
    peer_cwd: ctx.proc.cwd(),
    ts: ctx.clock.nowIso(),
    ...extra,
  })
  await atomicWrite(ctx, path, payload)
}

/** Broadcast a rename event to every live peer. Called from the heartbeat
 *  tick when resolveMyName() returns a value different from the previous
 *  tick — peers learn of the change immediately rather than at next send. */
export async function broadcastRename(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc' | 'env'>,
  targets: PresenceTargets,
  oldName: string,
  newName: string,
): Promise<LivePeer[]> {
  const peers = await liveEligiblePeers(ctx, targets)
  await Promise.all(
    peers.map(p =>
      writePresence(ctx, targets, p.id, 'rename', { old_name: oldName, new_name: newName }),
    ),
  )
  return peers
}

/** Enumerate live peers, applying three-layer self-exclusion + the v0.17
 *  pid-alive liveness check. Returns the list (used by broadcastPresence
 *  for fan-out AND by the boot-roster for the agent's first-seen view). */
export async function liveEligiblePeers(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc' | 'env'>,
  targets: PresenceTargets,
): Promise<LivePeer[]> {
  const known = await listKnownInstances(ctx, targets.stateRoot, targets.projectsRoot)
  const live: LivePeer[] = []
  for (const k of known) {
    if (await isSelf(ctx, targets.stateRoot, targets.me, targets.myName, k.id, k.name)) continue
    if (await isLivePeer(ctx, targets.stateRoot, k.id)) live.push({ id: k.id, name: k.name })
  }
  return live
}

/** Fan out `.hello` or `.goodbye` files into every eligible live peer's
 *  presence dir. Returns the list of peers actually written to. */
export async function broadcastPresence(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc' | 'env'>,
  targets: PresenceTargets,
  kind: 'hello' | 'goodbye',
): Promise<LivePeer[]> {
  const peers = await liveEligiblePeers(ctx, targets)
  await Promise.all(peers.map(p => writePresence(ctx, targets, p.id, kind)))
  return peers
}

export interface RosterParams {
  wedgePath: string
  peers: LivePeer[]
}

/** Emit a `roster` channel event to OWN agent — one line listing every
 *  live peer currently visible. Fires once at boot. */
export async function emitBootRoster(
  ctx: Pick<Context, 'mcp' | 'clock' | 'proc' | 'fs'>,
  params: RosterParams,
): Promise<void> {
  if (params.peers.length === 0) return
  const labels = params.peers
    .map(p => p.name || p.id.slice(0, 8))
    .sort()
    .join(', ')
  const meta = {
    source: 'choros-presence',
    event: 'roster',
    peer_ids: params.peers.map(p => p.id).join(','),
    peer_names: params.peers.map(p => p.name ?? p.id.slice(0, 8)).join(','),
    count: String(params.peers.length),
  }
  await withTimeout(
    ctx,
    ctx.mcp.notify('notifications/claude/channel', {
      content: `Other agents online: ${labels}`,
      meta,
    }),
    PUSH_TIMEOUT_MS,
    'boot-roster',
  )
}

/** Read a `.hello` / `.goodbye` file from OWN presence dir and emit a
 *  channel event to the agent. Returns whether the file was unlinked
 *  (which it is iff the push resolved). */
export async function emitPresence(
  ctx: Pick<Context, 'fs' | 'mcp' | 'clock' | 'proc'>,
  ownPresenceDir: string,
  me: string,
  filename: string,
): Promise<'emitted' | 'skipped' | 'self' | 'timeout'> {
  if (filename.startsWith('.')) return 'skipped'
  if (
    !filename.endsWith('.hello') &&
    !filename.endsWith('.goodbye') &&
    !filename.endsWith('.rename')
  ) {
    return 'skipped'
  }
  const path = join(ownPresenceDir, filename)
  let raw: string
  try {
    raw = await ctx.fs.readFile(path)
  } catch {
    return 'skipped'
  }
  let data: {
    peer_id?: string
    peer_name?: string
    event?: string
    old_name?: string
    new_name?: string
  }
  try {
    data = JSON.parse(raw)
  } catch {
    return 'skipped'
  }
  if (data.peer_id === me) {
    try {
      await ctx.fs.unlink(path)
    } catch {
      /* race with another consumer */
    }
    return 'self'
  }
  const peerLabel = data.peer_name || data.peer_id?.slice(0, 8) || 'unknown'
  const meta: Record<string, string> = {
    source: 'choros-presence',
    event: String(data.event ?? ''),
    peer_id: String(data.peer_id ?? ''),
    peer_name: String(data.peer_name ?? ''),
  }
  if (data.old_name) meta.old_name = data.old_name
  if (data.new_name) meta.new_name = data.new_name
  let content: string
  if (data.event === 'join') content = `Peer ${peerLabel} came online`
  else if (data.event === 'leave') content = `Peer ${peerLabel} went offline`
  else if (data.event === 'rename') {
    content = `Peer ${data.old_name ?? '?'} renamed to ${data.new_name ?? '?'}`
  } else content = `Peer ${peerLabel} presence event: ${data.event}`
  const result = await withTimeout(
    ctx,
    ctx.mcp.notify('notifications/claude/channel', { content, meta }),
    PUSH_TIMEOUT_MS,
    `presence ${filename}`,
  )
  // Always unlink — presence is fire-and-forget. On timeout we still drop
  // the file so it doesn't accumulate forever waiting for a wedged CC to
  // recover. A missed presence event is acceptable; an unbounded growing
  // presence dir is not. (The hello/goodbye/rename will reappear next boot
  // or rename respectively.)
  try {
    await ctx.fs.unlink(path)
  } catch {
    /* already gone */
  }
  return result === 'ok' ? 'emitted' : 'timeout'
}

export type _ReferencedKnownInstance = KnownInstance
