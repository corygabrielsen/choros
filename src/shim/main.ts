#!/usr/bin/env bun
/**
 * choros MCP shim — thin per-CC process that bridges Claude Code's
 * MCP tool calls to the long-lived choros daemon.
 *
 * Per-CC responsibilities:
 *   1. Resolve session identity (UUID + display name) once at boot
 *   2. Connect to `$XDG_STATE_HOME/choros/daemon.sock`
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
  ERR_UNKNOWN_SESSION,
  PROTOCOL_VERSION,
  type RegisterResult,
} from '#choros/protocol/methods.ts'
import { resolveDisplayName } from '#choros/shim/display-name.ts'
import { connectRpcClient } from '#choros/shim/rpc-client.ts'
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

const server = new Server(
  { name: 'choros', version: SHIM_VERSION },
  { capabilities: { tools: {} } },
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
    if (method === 'choros.inbound_message' && typeof p.msg_id === 'string') {
      try {
        await rpc.call('choros.confirm_delivery', { session_id: ME, msg_id: p.msg_id })
      } catch (e: unknown) {
        const m = e instanceof Error ? e.message : String(e)
        ctx.proc.stderr(`[choros-shim] confirm_delivery failed: ${m}\n`)
      }
    }
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e)
    ctx.proc.stderr(`[choros-shim] notify failed: ${m}\n`)
  }
}

const rpc = await connectRpcClient({
  socketPath: DAEMON_SOCK,
  onNotification: (method, params) => {
    void emitDaemonNotification(method, params)
  },
  onConnect: async () => {
    try {
      cachedDisplayName = await currentDisplayName()
      const result = await rpc.call<RegisterResult>('choros.register', {
        protocol_version: PROTOCOL_VERSION,
        session_id: ME,
        display_name: cachedDisplayName,
        host: ctx.env.hostname(),
        cwd: ctx.proc.cwd(),
        pid: ctx.proc.pid(),
      })
      // Re-emit any buffered notifications drained on registration.
      for (const buffered of result.pending) {
        await emitDaemonNotification(buffered.method, buffered.params)
      }
      ctx.proc.stderr(
        `[choros-shim] v${SHIM_VERSION} registered with daemon (proto=${result.protocol_version}, daemon=${result.daemon_version}), drained ${result.pending.length} pending\n`,
      )
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e)
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
    ],
  }),
)

server.setRequestHandler(CallToolRequestSchema, async req => {
  const args = injectSession(req.params.arguments as Record<string, unknown> | undefined)
  const result = await rpc.call(`choros.${req.params.name}`, args)
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
})

await server.connect(new StdioServerTransport())

// Periodic heartbeat + /rename detection. ERR_UNKNOWN_SESSION means
// the daemon dropped our session row (e.g. cleared by an admin /
// migration) — force a re-register by exiting; systemd / launchd
// will re-spawn the shim if managed.
const heartbeatInterval = setInterval(() => {
  void (async (): Promise<void> => {
    try {
      await rpc.call('choros.heartbeat', { session_id: ME, pid: ctx.proc.pid() })
      // Check for /rename — cheap when the JSONL hasn't grown.
      const name = await currentDisplayName()
      if (name !== cachedDisplayName) {
        cachedDisplayName = name
        try {
          await rpc.call('choros.set_display_name', { session_id: ME, display_name: name })
        } catch (e: unknown) {
          const m = e instanceof Error ? e.message : String(e)
          ctx.proc.stderr(`[choros-shim] set_display_name failed: ${m}\n`)
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes(String(ERR_UNKNOWN_SESSION)) || msg.includes('not registered')) {
        ctx.proc.stderr('[choros-shim] heartbeat: session unknown — forcing reconnect\n')
        void rpc.close().then(() => process.exit(1))
      }
      /* transient disconnect: reconnect loop will re-register */
    }
  })()
}, HEARTBEAT_INTERVAL_MS)

let shuttingDown = false
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

ctx.proc.stderr(
  `[choros-shim] v${SHIM_VERSION} session=${ME} (source=${identity.source}) daemon=${DAEMON_SOCK}\n`,
)
