#!/usr/bin/env bun
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { emitAck } from './acks.ts'
import { AskRegistry } from './ask-registry.ts'
import { cleanupOrphanTmpFiles, type WedgeState } from './delivery.ts'
import { type Context, type Mcp, realContext } from './effects.ts'
import {
  type AgentState,
  buildHeartbeat,
  HEARTBEAT_INTERVAL_MS,
  readAgentState,
  writeHeartbeat,
} from './heartbeat.ts'
import { createNameCache, resolveIdentity, resolveMyNameCached } from './identity.ts'
import { asStringField, emitInboxMessage } from './inbox.ts'
import { broadcastPresence, broadcastRename, emitBootRoster, emitPresence } from './presence.ts'
import { projectsRoot, resolveStateRoot } from './state-root.ts'
import { handleAsk } from './tools/ask.ts'
import { handleBroadcast } from './tools/broadcast.ts'
import { handleDoctor } from './tools/doctor.ts'
import { handlePublish } from './tools/publish.ts'
import { handleReact } from './tools/react.ts'
import { handleSend } from './tools/send.ts'
import { handleSetIntent, handleSetStatus } from './tools/set_state.ts'
import { handleSubscribe, handleUnsubscribe } from './tools/subscribe.ts'
import {
  handleJoinThread,
  handleLeaveThread,
  handleListThreads,
  handleSendToThread,
} from './tools/threads.ts'
import { setupWatcher, type WatcherHandle } from './watcher.ts'

const server = new Server({ name: 'choros', version: '0.28.0' }, { capabilities: { tools: {} } })

const mcpAdapter: Mcp = {
  async notify(method, params) {
    await server.notification({ method, params: params as Record<string, unknown> })
  },
}

const ctx: Context = realContext(mcpAdapter)

process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e?.code === 'EPIPE') {
    ctx.proc.stderr('[choros] stdout EPIPE — exiting so CC respawns\n')
    void shutdownAsync().finally(() => ctx.proc.exit(0))
    return
  }
  ctx.proc.stderr(`[choros] stdout error: ${e}\n`)
  void shutdownAsync().finally(() => ctx.proc.exit(1))
})

// stderr EPIPE would otherwise emit an unhandled 'error' event and
// crash the bun without running shutdownAsync. We can't usefully log
// the failure (stderr is the channel that's broken) but we can still
// run the async shutdown so peers see a goodbye.
process.stderr.on('error', () => {
  void shutdownAsync().finally(() => ctx.proc.exit(1))
})

const STATE_ROOT = resolveStateRoot(ctx)
const PROJECTS_ROOT = projectsRoot(ctx)
const identity = await resolveIdentity(ctx, PROJECTS_ROOT)
const ME = identity.me
const MY_ROOT = join(STATE_ROOT, ME)
const MY_INBOX = join(MY_ROOT, 'inbox')
const MY_READ = join(MY_INBOX, 'read')
const MY_SENT = join(MY_ROOT, 'sent')
const MY_ACKS = join(MY_ROOT, 'sent_acks')
const MY_PRESENCE = join(MY_ROOT, 'presence')
const HEARTBEAT_PATH = join(MY_ROOT, '.heartbeat')
const AGENT_STATE_PATH = join(MY_ROOT, '.agent_state')
const WEDGE_PATH = join(MY_ROOT, '.wedged')
const SUBSCRIPTIONS_PATH = join(MY_ROOT, '.subscriptions')

for (const dir of [MY_INBOX, MY_READ, MY_SENT, MY_ACKS, MY_PRESENCE]) {
  await ctx.fs.mkdir(dir, { recursive: true })
}

// Sweep orphan `*.tmp` files left by peers (or by this session) whose
// atomicWrite was killed mid-rename. Peers write to our inbox/presence/
// sent_acks dirs, and a force-killed peer leaves us holding the tmp.
// Unlinking files whose embedded writer-pid is dead is safe.
for (const dir of [MY_INBOX, MY_ACKS, MY_PRESENCE]) {
  const removed = await cleanupOrphanTmpFiles(ctx, dir)
  if (removed > 0) ctx.proc.stderr(`[choros] swept ${removed} orphan .tmp file(s) from ${dir}\n`)
}

// Clear any `.wedged` marker from the previous bun lifetime. The marker
// is gated on an in-memory `consecutiveTimeouts` counter that resets on
// restart, so without an explicit boot clear, peers would see the new
// bun as permanently wedged until it actually times out 3 more times.
try {
  await ctx.fs.unlink(join(MY_ROOT, '.wedged'))
} catch {
  /* no stale marker — expected on a clean prior shutdown */
}

// Refuse to start if another live bun holds this identity. Without this,
// two buns for the same session race on heartbeat writes, inbox watching,
// and presence broadcasts. We use the heartbeat pid (not a separate lock
// file) so a clean exit naturally clears the claim.
const LOCK_PATH = join(MY_ROOT, '.lock')
async function takeLock(): Promise<void> {
  let holder: { pid?: number; started?: string } | null = null
  try {
    holder = JSON.parse(await ctx.fs.readFile(LOCK_PATH))
  } catch {
    /* no lock yet */
  }
  if (holder && typeof holder.pid === 'number' && holder.pid !== ctx.proc.pid()) {
    if (await ctx.proc.pidAlive(holder.pid)) {
      ctx.proc.stderr(
        `[choros] identity ${ME} already locked by pid ${holder.pid} (started ${holder.started ?? '?'}). Refusing to start a second bun for the same session.\n`,
      )
      ctx.proc.exit(1)
    }
  }
  await ctx.fs.writeFile(
    LOCK_PATH,
    JSON.stringify({ pid: ctx.proc.pid(), started: new Date().toISOString() }),
  )
}
await takeLock()

const wedge: WedgeState = { consecutiveTimeouts: 0 }
const droppedAcksEmitted = new Set<string>()
const inFlightEmits = new Set<string>()
const askRegistry = new AskRegistry(line => ctx.proc.stderr(line))
const nameCache = createNameCache()
let myName = await resolveMyNameCached(ctx, identity, PROJECTS_ROOT, nameCache)
// Inherit any status/intent the previous bun lifetime persisted, so a
// /rename or set_status survives a restart. The agent can still call
// set_status/set_intent at any time to override.
let agentState: AgentState = await readAgentState(ctx, AGENT_STATE_PATH)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'send', description: 'Send a message to a peer.', inputSchema: { type: 'object' } },
    {
      name: 'broadcast',
      description: 'Broadcast to every live peer.',
      inputSchema: { type: 'object' },
    },
    { name: 'publish', description: 'Publish to a topic.', inputSchema: { type: 'object' } },
    { name: 'subscribe', description: 'Subscribe to a topic.', inputSchema: { type: 'object' } },
    {
      name: 'unsubscribe',
      description: 'Unsubscribe from a topic.',
      inputSchema: { type: 'object' },
    },
    { name: 'react', description: 'React to a received message.', inputSchema: { type: 'object' } },
    { name: 'set_status', description: 'Set ambient status.', inputSchema: { type: 'object' } },
    { name: 'set_intent', description: 'Set ambient intent.', inputSchema: { type: 'object' } },
    { name: 'doctor', description: 'Diagnostic snapshot.', inputSchema: { type: 'object' } },
    {
      name: 'join_thread',
      description: 'Join a persistent thread and read its backlog.',
      inputSchema: { type: 'object' },
    },
    {
      name: 'leave_thread',
      description: 'Leave a thread.',
      inputSchema: { type: 'object' },
    },
    {
      name: 'list_threads',
      description: 'List threads this session belongs to.',
      inputSchema: { type: 'object' },
    },
    {
      name: 'send_to_thread',
      description: 'Append a message to a thread; fans out to every member.',
      inputSchema: { type: 'object' },
    },
    {
      name: 'ask',
      description: 'Send a QUESTION to a peer and block until they reply (or timeout).',
      inputSchema: { type: 'object' },
    },
  ],
}))

// In-flight tool handler promises tracked so shutdown can drain them.
// Without this, SIGTERM mid-tool would `process.exit(0)` while a
// handleSend was awaiting an atomicWrite — the file would be left as
// a stranded .tmp on disk. The shutdown drainer awaits these with a
// hard deadline so a wedged handler doesn't block exit indefinitely.
const inFlightHandlers = new Set<Promise<unknown>>()

server.setRequestHandler(CallToolRequestSchema, async req => {
  const work = handleToolRequest(req)
  inFlightHandlers.add(work)
  try {
    return await work
  } finally {
    inFlightHandlers.delete(work)
  }
})

async function handleToolRequest(
  req: Parameters<Parameters<typeof server.setRequestHandler<typeof CallToolRequestSchema>>[1]>[0],
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  switch (req.params.name) {
    case 'send': {
      const r = await handleSend(
        ctx,
        { stateRoot: STATE_ROOT, projectsRoot: PROJECTS_ROOT, me: ME, myName, mySentDir: MY_SENT },
        args as Parameters<typeof handleSend>[2],
      )
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
    }
    case 'broadcast': {
      const r = await handleBroadcast(
        ctx,
        { stateRoot: STATE_ROOT, projectsRoot: PROJECTS_ROOT, me: ME, myName, mySentDir: MY_SENT },
        args as Parameters<typeof handleBroadcast>[2],
      )
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
    }
    case 'publish': {
      const r = await handlePublish(
        ctx,
        { stateRoot: STATE_ROOT, projectsRoot: PROJECTS_ROOT, me: ME, myName, mySentDir: MY_SENT },
        args as Parameters<typeof handlePublish>[2],
      )
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
    }
    case 'subscribe': {
      const r = await handleSubscribe(
        ctx,
        { subscriptionsPath: SUBSCRIPTIONS_PATH },
        asStringField(args.topic, 'topic'),
      )
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
    }
    case 'unsubscribe': {
      const r = await handleUnsubscribe(
        ctx,
        { subscriptionsPath: SUBSCRIPTIONS_PATH },
        asStringField(args.topic, 'topic'),
      )
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
    }
    case 'react': {
      const r = await handleReact(
        ctx,
        { stateRoot: STATE_ROOT, me: ME, myName },
        args as Parameters<typeof handleReact>[2],
      )
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
    }
    case 'set_status': {
      const r = await handleSetStatus(
        ctx,
        { agentStatePath: AGENT_STATE_PATH },
        asStringField(args.text, 'text'),
      )
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
    }
    case 'set_intent': {
      const r = await handleSetIntent(
        ctx,
        { agentStatePath: AGENT_STATE_PATH },
        asStringField(args.text, 'text'),
      )
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
    }
    case 'doctor': {
      const r = await handleDoctor(ctx, {
        stateRoot: STATE_ROOT,
        projectsRoot: PROJECTS_ROOT,
        me: ME,
        myName,
        inboxDir: MY_INBOX,
      })
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
    }
    case 'join_thread': {
      const r = await handleJoinThread(
        ctx,
        { stateRoot: STATE_ROOT, me: ME, myName, mySentDir: MY_SENT },
        asStringField(args.thread_id, 'thread_id'),
      )
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
    }
    case 'leave_thread': {
      const r = await handleLeaveThread(
        ctx,
        { stateRoot: STATE_ROOT, me: ME, myName, mySentDir: MY_SENT },
        asStringField(args.thread_id, 'thread_id'),
      )
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
    }
    case 'list_threads': {
      const r = await handleListThreads(ctx, { stateRoot: STATE_ROOT, me: ME })
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
    }
    case 'send_to_thread': {
      const r = await handleSendToThread(
        ctx,
        { stateRoot: STATE_ROOT, me: ME, myName, mySentDir: MY_SENT },
        args as Parameters<typeof handleSendToThread>[2],
      )
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
    }
    case 'ask': {
      const r = await handleAsk(
        ctx,
        { stateRoot: STATE_ROOT, projectsRoot: PROJECTS_ROOT, me: ME, myName, mySentDir: MY_SENT },
        askRegistry,
        args as Parameters<typeof handleAsk>[3],
      )
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
    }
    default:
      throw new Error(`unknown tool: ${req.params.name}`)
  }
}

async function tickHeartbeat(): Promise<void> {
  const previousName = myName
  myName = await resolveMyNameCached(ctx, identity, PROJECTS_ROOT, nameCache)
  // Re-read agent state each tick so updates from set_status / set_intent
  // (which atomicWrite to .agent_state) propagate without keeping a
  // separate in-memory copy that could drift from disk.
  agentState = await readAgentState(ctx, AGENT_STATE_PATH)
  const hb = buildHeartbeat(ctx, agentState)
  try {
    await writeHeartbeat(ctx, HEARTBEAT_PATH, hb)
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e)
    ctx.proc.stderr(`[choros] heartbeat write failed: ${m}\n`)
  }
  if (previousName !== myName) {
    const targets = { stateRoot: STATE_ROOT, projectsRoot: PROJECTS_ROOT, me: ME, myName }
    try {
      const peers = await broadcastRename(ctx, targets, previousName, myName)
      ctx.proc.stderr(
        `[choros] rename ${previousName} → ${myName}; broadcast to ${peers.length} peer(s)\n`,
      )
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e)
      ctx.proc.stderr(`[choros] rename broadcast failed: ${m}\n`)
    }
  }
}

await tickHeartbeat()
const heartbeatInterval = setInterval(() => {
  void tickHeartbeat()
}, HEARTBEAT_INTERVAL_MS)

await server.connect(new StdioServerTransport())

// Recomputed at each use so the freshest myName flows into the broadcast.
const helloPeers = await broadcastPresence(
  ctx,
  { stateRoot: STATE_ROOT, projectsRoot: PROJECTS_ROOT, me: ME, myName },
  'hello',
)
await emitBootRoster(ctx, { wedgePath: WEDGE_PATH, peers: helloPeers })

// All three watchers (inbox / presence / sent_acks) share the same
// lifecycle: spawn inotifywait, post-spawn prescan, periodic sweep,
// bounded-concurrency prescan dispatch, capped respawn on death, and
// graceful fallback to sweep-only when inotifywait is unavailable.
const shuttingDownFlag = { value: false }
const SWEEP_INTERVAL_MS_VALUE = 60_000
const PRESCAN_CONCURRENCY = 16
const WATCHER_RESPAWN_CAP = 5

const watcherHandles: WatcherHandle[] = []
watcherHandles.push(
  setupWatcher(ctx, {
    dir: MY_INBOX,
    label: 'inbox',
    sweepIntervalMs: SWEEP_INTERVAL_MS_VALUE,
    maxConcurrent: PRESCAN_CONCURRENCY,
    respawnCap: WATCHER_RESPAWN_CAP,
    shuttingDown: shuttingDownFlag,
    emit: filename =>
      emitInboxMessage(
        ctx,
        {
          stateRoot: STATE_ROOT,
          projectsRoot: PROJECTS_ROOT,
          me: ME,
          myName,
          wedgePath: WEDGE_PATH,
          inboxDir: MY_INBOX,
          readDir: MY_READ,
        },
        wedge,
        droppedAcksEmitted,
        inFlightEmits,
        filename,
        askRegistry,
      ),
  }),
)
watcherHandles.push(
  setupWatcher(ctx, {
    dir: MY_PRESENCE,
    label: 'presence',
    sweepIntervalMs: SWEEP_INTERVAL_MS_VALUE,
    maxConcurrent: PRESCAN_CONCURRENCY,
    respawnCap: WATCHER_RESPAWN_CAP,
    shuttingDown: shuttingDownFlag,
    emit: filename => emitPresence(ctx, MY_PRESENCE, ME, filename),
  }),
)
watcherHandles.push(
  setupWatcher(ctx, {
    dir: MY_ACKS,
    label: 'sent_acks',
    sweepIntervalMs: SWEEP_INTERVAL_MS_VALUE,
    maxConcurrent: PRESCAN_CONCURRENCY,
    respawnCap: WATCHER_RESPAWN_CAP,
    shuttingDown: shuttingDownFlag,
    emit: filename => emitAck(ctx, MY_ACKS, filename),
  }),
)

// Synchronous part of shutdown — safe to call from process 'exit' handler
// where async work cannot complete. Stops the heartbeat tick, stops every
// watcher (kills its inotify child and clears its sweep interval), and
// releases the identity lock so a fresh bun for this session can start
// without manual cleanup.
function shutdownSync(): void {
  if (shuttingDownFlag.value) return
  shuttingDownFlag.value = true
  clearInterval(heartbeatInterval)
  for (const h of watcherHandles) h.stop()
  try {
    ctx.fs.unlinkSync(LOCK_PATH)
  } catch {
    /* lock already gone or never claimed */
  }
}

let shutdownAsyncPromise: Promise<void> | null = null

// Async shutdown — runs on SIGINT/SIGTERM where we still have the event loop.
// Broadcasts a goodbye to live peers with a hard deadline so a wedged peer
// doesn't block us indefinitely. Recomputes targets so the freshest myName
// is broadcast (the heartbeat tick may have updated it since boot).
function shutdownAsync(): Promise<void> {
  // Idempotent across concurrent signals. The first SIGINT/SIGTERM
  // installs the promise; later signals await the same one rather than
  // racing on broadcastPresence + re-running the timeout.
  if (shutdownAsyncPromise) return shutdownAsyncPromise
  shutdownAsyncPromise = (async (): Promise<void> => {
    shutdownSync()
    // Drain in-flight tool handlers with a hard deadline so a wedged
    // handler (stuck on a hung await) can't block exit indefinitely.
    // 2s mirrors the goodbye broadcast deadline.
    if (inFlightHandlers.size > 0) {
      ctx.proc.stderr(`[choros] draining ${inFlightHandlers.size} in-flight handler(s)\n`)
      await Promise.race([
        Promise.allSettled([...inFlightHandlers]),
        new Promise<void>(resolve => setTimeout(resolve, 2_000)),
      ])
    }
    try {
      const targets = { stateRoot: STATE_ROOT, projectsRoot: PROJECTS_ROOT, me: ME, myName }
      await Promise.race([
        broadcastPresence(ctx, targets, 'goodbye'),
        new Promise<void>(resolve => setTimeout(resolve, 2_000)),
      ])
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e)
      ctx.proc.stderr(`[choros] goodbye broadcast failed: ${m}\n`)
    }
  })()
  return shutdownAsyncPromise
}

process.on('exit', shutdownSync)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    void shutdownAsync().finally(() => ctx.proc.exit(0))
  })
}

ctx.proc.stderr(
  `[choros] v0.28 channel up: session=${ME} (source=${identity.source}) name="${myName}"\n` +
    `[choros] inbox=${MY_INBOX} heartbeat=${HEARTBEAT_PATH} pid=${ctx.proc.pid()}\n` +
    `[choros] presence broadcast to ${helloPeers.length} live peer(s)\n`,
)
