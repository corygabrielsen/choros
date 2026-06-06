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
import { NOTIFY_DAEMON, NOTIFY_ROSTER } from '#choros/protocol/notifications.ts'
import { readCcSessionFile, readCcSessionFileWithRetry } from '#choros/shim/cc-session-file.ts'
import {
  JSONL_VERIFY_TIMEOUT_MS,
  jsonlSize,
  PUSH_TIMEOUT_MS,
  verifyJsonlReceipt,
  withTimeout,
} from '#choros/shim/delivery.ts'
import { findJsonl, resolveDisplayName } from '#choros/shim/display-name.ts'
import { connectRpcClient, type RpcClient } from '#choros/shim/rpc-client.ts'
import { daemonSocketPath, projectsRoot } from '#choros/state-root.ts'
import { CHOROS_TOOLS } from '#choros/tools.ts'

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

// CC's `~/.claude/sessions/<ppid>.json` carries the authoritative
// sessionId + display name. Try it first (with bounded retry to ride
// out CC's startup-write race). Fall back to the legacy heuristic
// chain when running outside CC (test, debug, headless / sdk-cli on
// older CC versions that don't write this file).
const HOME = ctx.env.homedir()
const ccSession = await readCcSessionFileWithRetry(HOME, ctx.proc.ppid())
const identity =
  ccSession === null
    ? await resolveIdentity(ctx, projectsRoot(ctx))
    : { me: ccSession.sessionId, meIsUuid: true, source: 'cc-session-file' as const }
const ME = identity.me
const DAEMON_SOCK = daemonSocketPath()
const PROJECTS_ROOT = projectsRoot(ctx)
const CC_PPID = ctx.proc.ppid()

function currentDisplayName(): Promise<string | null> {
  if (!identity.meIsUuid) return Promise.resolve(identity.me)
  // CC's per-process session file is the canonical source of the
  // display name — covers `/rename`, `--continue`, `--resume "X"`,
  // and any session length. JSONL tail-scan stays as fallback for
  // sdk-cli (file present, name null) and non-CC parents (no file).
  return readCcSessionFile(HOME, CC_PPID).then(cc => {
    if (cc?.name) return cc.name
    return resolveDisplayName({
      sessionId: ME,
      projectsRoot: PROJECTS_ROOT,
      pwd: ctx.env.get('PWD') || ctx.proc.cwd(),
    })
  })
}

// Locate this session's own CC transcript for delivery verification. Null
// for synthetic (non-UUID) sessions — they have no transcript, so their
// pushes are taken on trust rather than verified.
function locateOwnJsonl(): Promise<string | null> {
  if (!identity.meIsUuid) return Promise.resolve(null)
  return findJsonl({
    sessionId: ME,
    projectsRoot: PROJECTS_ROOT,
    pwd: ctx.env.get('PWD') || ctx.proc.cwd(),
  })
}

// Cached display name. The shim re-checks it on every heartbeat; if
// it changes, push the new value to the daemon so peers can route
// by-name to the freshly-renamed session.
let cachedDisplayName: string | null = null

// Cached daemon `started_at` from the most recent register handshake.
// A change across registers means the daemon was restarted between our
// connect attempts — emit `choros.daemon` `restarted` so the CC can
// frame the burst of presence rejoin / roster events that follow.
let cachedDaemonStartedAt: string | null = null

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
      'Messages from other Claude Code sessions arrive as <channel source="choros" kind="choros" from_name="<sender>" msg_id="<id>" ...> events. ' +
      'The kind attribute names the sub-event: kind="choros" is a peer message; "choros-ack" (status=delivered|dropped) is a delivery receipt; "choros-reaction"/"choros-read_receipt"/"choros-presence"/"choros-roster" are engagement/presence signals. ' +
      'To reply, call the choros send tool with to=<from_name> (and in_reply_to=<msg_id> to thread). ' +
      'Mark a message handled with the choros mark_read tool passing its msg_id. Act on inbound peer messages; do not ignore them.',
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
  // Each daemon notification maps to a channel sub-event `kind`. This is
  // `kind`, NOT `source`: Claude Code sets the channel tag's `source`
  // attribute from the server name ("choros"), so a meta `source` renders
  // a second, conflicting `source=` on the tag. Read `kind` for the type:
  //   choros.inbound_message → kind="choros"
  //   choros.ack             → kind="choros-ack"
  //   choros.reaction        → kind="choros-reaction"
  //   choros.read_receipt    → kind="choros-read_receipt"
  //   choros.presence        → kind="choros-presence"
  //   choros.roster          → kind="choros-roster"
  const kind = method.replace(/^choros\./, 'choros-').replace('choros-inbound_message', 'choros')
  const p = (params ?? {}) as Record<string, unknown>
  const content = typeof p.body === 'string' ? p.body : ''
  const meta: Record<string, string> = { kind }
  for (const [k, v] of Object.entries(p)) {
    if (k === 'body') continue
    if (typeof v === 'string') meta[k] = v
    else if (typeof v === 'number' || typeof v === 'boolean') meta[k] = String(v)
  }

  const msgId = method === 'choros.inbound_message' && typeof p.msg_id === 'string' ? p.msg_id : ''

  // Capture the transcript size BEFORE the push so the delta scan starts
  // past existing history — an older record embedding the same msg_id
  // can't false-match. Only inbound messages are verified + confirmed.
  let jsonl: string | null = null
  let startSize = 0
  if (msgId) {
    jsonl = await locateOwnJsonl()
    startSize = await jsonlSize(jsonl)
  }

  const pushed = await withTimeout(
    server.notification({ method: 'notifications/claude/channel', params: { content, meta } }),
    PUSH_TIMEOUT_MS,
    m => ctx.proc.stderr(`[choros-shim] push rejected: ${m}\n`),
  )

  if (!msgId) return

  // Detached: verifying receipt polls the transcript for up to
  // JSONL_VERIFY_TIMEOUT_MS. Awaiting here would serialize the next inbound
  // message — and stall a backlog drain — behind this poll.
  void verifyAndReport(jsonl, startSize, msgId, pushed)
}

/** Confirm or repudiate a single inbound delivery. A push that resolved
 *  AND whose msg_id surfaced in this session's own transcript is a real
 *  delivery → `confirm_delivery` (sender gets `choros.ack status=delivered`).
 *  A push that timed out, or resolved but never surfaced, is a silent drop
 *  → `report_drop` (sender gets `status=dropped`; the daemon wedges the
 *  session after repeated drops). The ack never claims more than the
 *  transcript proves. */
async function verifyAndReport(
  jsonl: string | null,
  startSize: number,
  msgId: string,
  pushed: 'ok' | 'timeout',
): Promise<void> {
  // activeClient ?? rpc — never touch `rpc` while activeClient is set
  // (same object post-init, but `rpc` is in TDZ during the first-connect
  // drain that can call this).
  const client = activeClient ?? rpc
  const delivered =
    pushed === 'ok' && (await verifyJsonlReceipt(jsonl, msgId, startSize, JSONL_VERIFY_TIMEOUT_MS))
  const rpcMethod = delivered ? 'choros.confirm_delivery' : 'choros.report_drop'
  try {
    await client.call(rpcMethod, { session_id: ME, msg_id: msgId })
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e)
    ctx.proc.stderr(`[choros-shim] ${rpcMethod} failed: ${m}\n`)
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
  // Daemon-restart detection: if the cached `started_at` differs from
  // the value returned by this register, the daemon was restarted
  // between our last successful register and this one. Emit BEFORE
  // draining buffered notifications so the CC sees the lifecycle frame
  // before the rejoin burst it's contextualising.
  const startedAt = result.daemon_started_at
  if (startedAt && cachedDaemonStartedAt !== null && cachedDaemonStartedAt !== startedAt) {
    await emitDaemonNotification(NOTIFY_DAEMON, {
      event: 'restarted',
      body: `choros daemon restarted (started ${startedAt}); peers reconnecting`,
      ts: startedAt,
      daemon_version: result.daemon_version,
      daemon_started_at: startedAt,
      previous_started_at: cachedDaemonStartedAt,
    })
  }
  if (startedAt) cachedDaemonStartedAt = startedAt
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
    tools: CHOROS_TOOLS,
  }),
)

server.setRequestHandler(CallToolRequestSchema, async req => {
  // Sync the display name before forwarding so the first message after
  // a /rename stamps the new `from_name` — without this the daemon
  // only learns the new name on the next heartbeat tick (up to
  // HEARTBEAT_INTERVAL_MS later) and any send/broadcast in the gap
  // ships with the pre-rename name (or null, for first-ever sessions).
  // Cheap when the name is unchanged: resolveDisplayName has an
  // mtime+size fs-cache and syncDisplayName short-circuits on no
  // delta, so the steady-state cost is one stat() call.
  await syncDisplayName()
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
