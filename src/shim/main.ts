#!/usr/bin/env bun
/**
 * choros MCP shim — thin per-CC process that bridges Claude Code's
 * MCP tool calls to the long-lived choros daemon.
 *
 * Per-CC responsibilities:
 *   1. Resolve session identity (UUID + display name) once at boot
 *   2. Connect to `~/.local/state/choros/daemon.sock` (or $CHOROS_STATE_HOME)
 *   3. Forward every MCP tool call as a JSON-RPC request, tagged with
 *      this session's id, return the daemon's result verbatim
 *   4. Subscribe to daemon notifications; re-emit each as a CC
 *      `mcp.notification`
 *   5. Heartbeat the daemon every HEARTBEAT_INTERVAL_MS
 *   6. Deregister cleanly on SIGTERM / SIGINT / SIGHUP / stdout EPIPE
 *
 * The shim contains essentially no business logic — that all lives in
 * the daemon. Updates to choros logic restart the daemon only; the
 * shim binary changes rarely.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { realContext } from '#choros/effects.ts'
import { resolveIdentity } from '#choros/identity.ts'
import {
  ERR_PROTOCOL_MISMATCH,
  ERR_UNKNOWN_SESSION,
  PROTOCOL_VERSION,
  type RegisterResult,
} from '#choros/protocol/methods.ts'
import { NOTIFY_ROSTER } from '#choros/protocol/notifications.ts'
import { resolveDisplayName } from '#choros/shim/display-name.ts'
import { connectRpcClient, type RpcClient } from '#choros/shim/rpc-client.ts'
import { daemonSocketPath, projectsRoot } from '#choros/state-root.ts'

const SHIM_VERSION = '1.0.0'
const HEARTBEAT_INTERVAL_MS = 30_000
const DEREGISTER_TIMEOUT_MS = 500

const ctx = realContext({
  notify(): Promise<void> {
    // The shim's own MCP push happens via `server.notification` below;
    // the realContext.mcp is only needed by code paths that the shim
    // doesn't exercise. Provide a no-op so resolveIdentity doesn't trip
    // on it.
    return Promise.resolve()
  },
})

const identity = await resolveIdentity(ctx, projectsRoot(ctx))
const ME = identity.me
const DAEMON_SOCK = daemonSocketPath()
const PROJECTS_ROOT = projectsRoot(ctx)

function currentDisplayName(): Promise<string | null> {
  if (!identity.meIsUuid) return Promise.resolve(identity.me)
  return resolveDisplayName({
    sessionId: ME,
    projectsRoot: PROJECTS_ROOT,
    pwd: ctx.env.get('PWD') || ctx.proc.cwd(),
  })
}

// Cached display name. The shim re-checks it on every heartbeat; if
// it changes, push the new value to the daemon so peers can route
// by-name to the freshly-renamed session.
let cachedDisplayName: string | null = null

// The live RPC client, set the first time register runs. emitDaemon-
// Notification's confirm_delivery needs a client during the first-ever
// connect's pending-drain — at that point the outer `const rpc` is
// still in its TDZ (onConnect fires from inside connectRpcClient before
// the const is assigned), so reaching for `rpc` there would throw.
let activeClient: RpcClient | undefined

const server = new Server(
  { name: 'choros', version: SHIM_VERSION },
  {
    // `experimental['claude/channel']` is what registers CC's notification
    // listener — without it every `notifications/claude/channel` push is
    // dropped silently. `tools` keeps the two-way surface (send, inbox, …).
    // Custom channels are off the research-preview allowlist, so each CC
    // session must still launch with `--dangerously-load-development-channels
    // server:choros` for these notifications to surface.
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions:
      'Messages from other Claude Code sessions arrive as <channel source="choros" from_name="<sender>" msg_id="<id>" ...> events ' +
      '(also source="choros-ack"/"choros-reaction"/"choros-read"/"choros-presence"/"choros-roster" for delivery/engagement/presence signals). ' +
      'To reply, call the choros send tool with to=<from_name> (and in_reply_to=<msg_id> to thread). ' +
      'Mark a message handled with the choros mark_read tool passing its msg_id. Act on inbound messages; do not ignore them.',
  },
)

// The shim forwards every tool call to the daemon; the call's argument
// gets an injected `session_id` so the daemon attributes the operation
// to this CC.
function injectSession(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return { ...(args ?? {}), session_id: ME }
}

process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e?.code === 'EPIPE') {
    ctx.proc.stderr('[choros-shim] stdout EPIPE — exiting\n')
    void shutdown('EPIPE').finally(() => ctx.proc.exit(0))
    return
  }
  ctx.proc.stderr(`[choros-shim] stdout error: ${e}\n`)
})
process.stderr.on('error', () => {
  void shutdown('stderr-error').finally(() => ctx.proc.exit(1))
})

async function emitDaemonNotification(method: string, params: unknown): Promise<void> {
  // Daemon notification methods mirror MCP channel sources:
  //   choros.inbound_message → source="choros"
  //   choros.ack             → source="choros-ack"
  //   choros.reaction        → source="choros-reaction"
  //   choros.read_receipt    → source="choros-read"
  //   choros.presence        → source="choros-presence"
  const source = method.replace(/^choros\./, 'choros-').replace('choros-inbound_message', 'choros')
  const p = (params ?? {}) as Record<string, unknown>
  const content = typeof p.body === 'string' ? p.body : ''
  const meta: Record<string, string> = { source }
  for (const [k, v] of Object.entries(p)) {
    if (k === 'body') continue
    if (typeof v === 'string') meta[k] = v
    else if (typeof v === 'number' || typeof v === 'boolean') meta[k] = String(v)
  }
  try {
    await server.notification({
      method: 'notifications/claude/channel',
      params: { content, meta },
    })
    // Inbound messages get a confirm_delivery call so the daemon can
    // close the loop and fire `choros.ack` back to the original sender.
    // Fire-and-forget: awaiting the round-trip would serialize the
    // next inbound message behind this one's ack, halving inbound
    // throughput.
    if (method === 'choros.inbound_message' && typeof p.msg_id === 'string') {
      const msgId = p.msg_id
      // activeClient ?? rpc — never touch `rpc` while activeClient is
      // set (it's the same object post-init, but `rpc` is in TDZ during
      // the first-connect drain that calls this).
      const client = activeClient ?? rpc
      client
        .call('choros.confirm_delivery', { session_id: ME, msg_id: msgId })
        .catch((e: unknown) => {
          const m = e instanceof Error ? e.message : String(e)
          ctx.proc.stderr(`[choros-shim] confirm_delivery failed: ${m}\n`)
        })
    }
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e)
    ctx.proc.stderr(`[choros-shim] notify failed: ${m}\n`)
  }
}

// Set true once shutdown begins; gates registration + heartbeat so a
// late re-register can't resurrect a session the clean shutdown tore
// down, and a tick can't run mid-teardown. Declared up here so the
// registration owner below can read it.
let shuttingDown = false

// Single registration owner: at most one register/re-register in
// flight at a time. onConnect (every reconnect) and the heartbeat
// unknown-session path both go through ensureRegistered, so overlapping
// triggers coalesce onto one round-trip instead of stacking 2-3.
let registerInFlight: Promise<void> | null = null
function ensureRegistered(client: RpcClient): Promise<void> {
  if (shuttingDown) return Promise.resolve()
  if (registerInFlight) return registerInFlight
  registerInFlight = registerWithDaemon(client).finally(() => {
    registerInFlight = null
  })
  return registerInFlight
}

/** Register (or re-register) this session with the daemon over an open
 *  connection: drains any buffered notifications and refreshes the
 *  cached display name. Always go through {@link ensureRegistered}, not
 *  this directly, so concurrent triggers coalesce. Throws on protocol
 *  mismatch (unrecoverable). */
async function registerWithDaemon(client: RpcClient): Promise<void> {
  activeClient = client
  cachedDisplayName = await currentDisplayName()
  const result = await client.call<RegisterResult>('choros.register', {
    protocol_version: PROTOCOL_VERSION,
    session_id: ME,
    display_name: cachedDisplayName,
    host: ctx.env.hostname(),
    cwd: ctx.proc.cwd(),
    pid: ctx.proc.pid(),
  })
  for (const buffered of result.pending) {
    await emitDaemonNotification(buffered.method, buffered.params)
  }
  // Surface "who's online" once on (re)connect. `roster` is guarded
  // (?? []) so a new shim against an older daemon that doesn't return
  // it degrades cleanly to no roster event.
  const roster = result.roster ?? []
  if (roster.length > 0) {
    const names = roster.map(p => p.display_name ?? p.session_id.slice(0, 8)).join(', ')
    await emitDaemonNotification(NOTIFY_ROSTER, {
      event: 'roster',
      count: roster.length,
      body: `${roster.length} online: ${names}`,
    })
  }
  ctx.proc.stderr(
    `[choros-shim] v${SHIM_VERSION} registered (proto=${result.protocol_version}, daemon=${result.daemon_version}); drained ${result.pending.length} pending, ${roster.length} peers online\n`,
  )
}

const rpc = await connectRpcClient({
  socketPath: DAEMON_SOCK,
  onNotification: (method, params) => {
    void emitDaemonNotification(method, params)
  },
  onConnect: async (client): Promise<void> => {
    try {
      await ensureRegistered(client)
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e)
      const code = (e as { code?: number })?.code
      // A protocol-version mismatch can't be recovered by reconnecting
      // — the daemon's contract is incompatible with this shim binary.
      // Bail hard so the wrapper can surface "reinstall shim" instead
      // of looping forever pretending to be connected.
      if (code === ERR_PROTOCOL_MISMATCH || m.includes('protocol mismatch')) {
        ctx.proc.stderr(`[choros-shim] ${m} — exiting; reinstall the matching shim\n`)
        ctx.proc.exit(2)
        return
      }
      ctx.proc.stderr(`[choros-shim] register failed: ${m}\n`)
    }
  },
})

server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
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
      {
        name: 'react',
        description: 'React to a received message.',
        inputSchema: { type: 'object' },
      },
      { name: 'set_status', description: 'Set ambient status.', inputSchema: { type: 'object' } },
      { name: 'set_intent', description: 'Set ambient intent.', inputSchema: { type: 'object' } },
      { name: 'doctor', description: 'Diagnostic snapshot.', inputSchema: { type: 'object' } },
      {
        name: 'join_thread',
        description: 'Join a persistent thread.',
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
        description: 'Append a message to a thread.',
        inputSchema: { type: 'object' },
      },
      {
        name: 'mark_read',
        description: 'Mark a received message as read.',
        inputSchema: { type: 'object' },
      },
      {
        name: 'inbox',
        description: 'Pull unread messages addressed to this session.',
        inputSchema: { type: 'object' },
      },
    ],
  }),
)

server.setRequestHandler(CallToolRequestSchema, async req => {
  const args = injectSession(req.params.arguments as Record<string, unknown> | undefined)
  const result = await rpc.call(`choros.${req.params.name}`, args)
  // Compact JSON — pretty-print costs ~2× bytes + CPU per tool call
  // and the consumer is the CC agent, which doesn't care about
  // human-readable indentation.
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
})

await server.connect(new StdioServerTransport())

/** Push a /rename to the daemon if the JSONL display name changed. */
async function syncDisplayName(): Promise<void> {
  const name = await currentDisplayName()
  if (name === cachedDisplayName) return
  cachedDisplayName = name
  try {
    await rpc.call('choros.set_display_name', { session_id: ME, display_name: name })
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e)
    ctx.proc.stderr(`[choros-shim] set_display_name failed: ${m}\n`)
  }
}

/** One heartbeat tick: heartbeat + rename detection, with in-place
 *  re-register if the daemon reports the session unknown (post-
 *  reconnect window or a genuine drop). Never exits — a dropped
 *  heartbeat is transient and the reconnect loop handles disconnects.
 *  Non-reentrant: a slow tick (awaiting a re-register up to the call
 *  timeout) must not overlap the next interval firing. */
let heartbeatRunning = false
async function heartbeatTick(): Promise<void> {
  if (heartbeatRunning || shuttingDown) return
  heartbeatRunning = true
  try {
    await rpc.call('choros.heartbeat', { session_id: ME, pid: ctx.proc.pid() })
    await syncDisplayName()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const code = (err as { code?: number })?.code
    if (code === ERR_UNKNOWN_SESSION || msg.includes('not registered')) {
      // The daemon doesn't know this session — either a genuine drop
      // (admin cleared the row) or the brief window after a reconnect
      // before register lands (the auth boundary reports "not
      // registered" until the binding exists). Re-register in place via
      // the registration owner (coalesces with onConnect's register);
      // do NOT exit — exiting kills the MCP server for the whole CC
      // session.
      ctx.proc.stderr('[choros-shim] heartbeat: session unknown — re-registering\n')
      try {
        await ensureRegistered(rpc)
      } catch (e: unknown) {
        const rm = e instanceof Error ? e.message : String(e)
        ctx.proc.stderr(`[choros-shim] re-register failed: ${rm}\n`)
      }
    }
    /* else transient disconnect: the reconnect loop re-registers */
  } finally {
    heartbeatRunning = false
  }
}

const heartbeatInterval = setInterval(() => void heartbeatTick(), HEARTBEAT_INTERVAL_MS)

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  ctx.proc.stderr(`[choros-shim] ${reason} — deregistering\n`)
  clearInterval(heartbeatInterval)
  // Cap the deregister wait so a wedged daemon can't block CC shutdown.
  // The daemon's own connection-close handler will tear down the
  // router binding on disconnect anyway.
  await Promise.race([
    rpc.call('choros.deregister', { session_id: ME }).catch(() => undefined),
    new Promise<void>(resolve => setTimeout(resolve, DEREGISTER_TIMEOUT_MS)),
  ])
  await rpc.close()
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    void shutdown(sig).finally(() => ctx.proc.exit(0))
  })
}

// Defense in depth: a stray rejection/exception must not take the MCP
// server down without a trace. Log and keep running — the RPC client
// reconnects on its own, and the MCP host stays up for the user.
process.on('unhandledRejection', reason => {
  const m = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  ctx.proc.stderr(`[choros-shim] unhandledRejection: ${m}\n`)
})
process.on('uncaughtException', err => {
  ctx.proc.stderr(`[choros-shim] uncaughtException: ${err.stack ?? err.message}\n`)
})

ctx.proc.stderr(
  `[choros-shim] v${SHIM_VERSION} session=${ME} (source=${identity.source}) daemon=${DAEMON_SOCK}\n`,
)
