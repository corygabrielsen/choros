#!/usr/bin/env bun
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { AskRegistry } from './ask-registry.ts'
import type { WedgeState } from './delivery.ts'
import { type Context, type Mcp, realContext } from './effects.ts'
import { HEARTBEAT_INTERVAL_MS, buildHeartbeat, writeHeartbeat } from './heartbeat.ts'
import { resolveIdentity, resolveMyName } from './identity.ts'
import { emitInboxMessage } from './inbox.ts'
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

const server = new Server({ name: 'choros', version: '0.23.0' }, { capabilities: { tools: {} } })

const mcpAdapter: Mcp = {
  async notify(method, params) {
    await server.notification({ method, params: params as Record<string, unknown> })
  },
}

const ctx: Context = realContext(mcpAdapter)

process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e?.code === 'EPIPE') {
    ctx.proc.stderr('[choros] stdout EPIPE — exiting so CC respawns\n')
    ctx.proc.exit(0)
  }
  ctx.proc.stderr(`[choros] stdout error: ${e}\n`)
})

const identity = resolveIdentity(ctx)
const STATE_ROOT = resolveStateRoot(ctx)
const PROJECTS_ROOT = projectsRoot(ctx)
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

const wedge: WedgeState = { consecutiveTimeouts: 0 }
const droppedAcksEmitted = new Set<string>()
const inFlightEmits = new Set<string>()
const askRegistry = new AskRegistry()
let myName = await resolveMyName(ctx, identity, PROJECTS_ROOT)

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

server.setRequestHandler(CallToolRequestSchema, async req => {
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
        String(args.topic ?? ''),
      )
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
    }
    case 'unsubscribe': {
      const r = await handleUnsubscribe(
        ctx,
        { subscriptionsPath: SUBSCRIPTIONS_PATH },
        String(args.topic ?? ''),
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
        String(args.text ?? ''),
      )
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
    }
    case 'set_intent': {
      const r = await handleSetIntent(
        ctx,
        { agentStatePath: AGENT_STATE_PATH },
        String(args.text ?? ''),
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
        String(args.thread_id ?? ''),
      )
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
    }
    case 'leave_thread': {
      const r = await handleLeaveThread(
        ctx,
        { stateRoot: STATE_ROOT, me: ME, myName, mySentDir: MY_SENT },
        String(args.thread_id ?? ''),
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
})

async function tickHeartbeat(): Promise<void> {
  const previousName = myName
  myName = await resolveMyName(ctx, identity, PROJECTS_ROOT)
  const hb = buildHeartbeat(ctx, {})
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

const inboxWatcher = ctx.spawner.spawn('inotifywait', [
  '-m',
  '-q',
  '-e',
  'close_write,moved_to',
  '--format',
  '%f',
  MY_INBOX,
])
inboxWatcher.onStdout(chunk => {
  for (const filename of chunk.split('\n').filter(Boolean)) {
    void emitInboxMessage(
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
    )
  }
})

const presenceWatcher = ctx.spawner.spawn('inotifywait', [
  '-m',
  '-q',
  '-e',
  'close_write,moved_to',
  '--format',
  '%f',
  MY_PRESENCE,
])
presenceWatcher.onStdout(chunk => {
  for (const filename of chunk.split('\n').filter(Boolean)) {
    void emitPresence(ctx, MY_PRESENCE, ME, filename)
  }
})

const watchers = [inboxWatcher, presenceWatcher]
let shuttingDown = false

// Synchronous part of shutdown — safe to call from process 'exit' handler
// where async work cannot complete. Stops the heartbeat tick and kills
// inotify children so they don't outlive us.
function shutdownSync(): void {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(heartbeatInterval)
  for (const w of watchers) w.kill()
}

// Async shutdown — runs on SIGINT/SIGTERM where we still have the event loop.
// Broadcasts a goodbye to live peers with a hard deadline so a wedged peer
// doesn't block us indefinitely. Recomputes targets so the freshest myName
// is broadcast (the heartbeat tick may have updated it since boot).
async function shutdownAsync(): Promise<void> {
  shutdownSync()
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
}

process.on('exit', shutdownSync)
process.on('SIGINT', () => {
  void shutdownAsync().finally(() => ctx.proc.exit(0))
})
process.on('SIGTERM', () => {
  void shutdownAsync().finally(() => ctx.proc.exit(0))
})

ctx.proc.stderr(
  `[choros] v0.23 channel up: session=${ME} (source=${identity.source}) name="${myName}"\n` +
    `[choros] inbox=${MY_INBOX} heartbeat=${HEARTBEAT_PATH} pid=${ctx.proc.pid()}\n` +
    `[choros] presence broadcast to ${helloPeers.length} live peer(s)\n`,
)
