/**
 * choros shim ↔ daemon JSON-RPC 2.0 protocol — method surface.
 *
 * The shim (per-CC MCP server) calls these methods over a single
 * bidirectional Unix-socket connection. NDJSON framing (one JSON-RPC
 * message per line) keeps the wire debuggable via `nc -U sock | jq`.
 *
 * Phase 1 ships only `register` / `deregister` / `heartbeat`.
 * Phase 2 ports each existing MCP tool to a `choros.<tool>` method
 * whose params include the caller's `session_id` so the daemon can
 * attribute side effects.
 */

/** Protocol version negotiated at `choros.register`. Daemon refuses
 *  shims with a mismatch and surfaces a human-readable error. Bump on
 *  every breaking wire change. */
export const PROTOCOL_VERSION = 2

/** Standard JSON-RPC 2.0 request envelope. */
export interface RpcRequest<P = unknown> {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: P
}

/** Standard JSON-RPC 2.0 response envelope. Exactly one of `result`
 *  or `error` is present. The id is null when the request that
 *  triggered the response was un-parseable or had an invalid id. */
export type RpcResponse<R = unknown> =
  | { jsonrpc: '2.0'; id: number | string | null; result: R }
  | { jsonrpc: '2.0'; id: number | string | null; error: RpcError }

/** Standard JSON-RPC 2.0 error envelope. Codes mirror the spec where
 *  they apply (-32601 for unknown method, -32602 for invalid params)
 *  and use the application-specific range (-32000…-32099) for choros-
 *  specific failures (protocol mismatch, unknown session, etc.). */
export interface RpcError {
  code: number
  message: string
  data?: unknown
}

/** Standard error codes. */
export const ERR_PARSE = -32700
export const ERR_INVALID_REQUEST = -32600
export const ERR_METHOD_NOT_FOUND = -32601
export const ERR_INVALID_PARAMS = -32602
export const ERR_INTERNAL = -32603
export const ERR_PROTOCOL_MISMATCH = -32000
export const ERR_UNKNOWN_SESSION = -32001
export const ERR_ALREADY_REGISTERED = -32002
/** Caller is not authorized to perform this operation on this object
 *  (e.g. reacting to a message they didn't receive, marking-read a
 *  message addressed to another session). Distinct from
 *  ERR_UNKNOWN_SESSION which means the *caller's* session row is
 *  gone — this is "you exist but this isn't yours." */
export const ERR_NOT_AUTHORIZED = -32003
/** Targeted object (message, thread) doesn't exist. Distinct from a
 *  silent no-op so the caller can react explicitly. */
export const ERR_NOT_FOUND = -32004

/* --- choros.register ---------------------------------------------------- */

export interface RegisterArgs {
  protocol_version: number
  session_id: string
  display_name: string | null
  host: string
  cwd: string
  /** Process pid of the shim, used by the daemon to detect dead shims
   *  during heartbeat aggregation. */
  pid: number
  /** Whether this connection is the live notification sink for the
   *  session. Defaults to true for legacy Claude shims. Tool-only
   *  Codex MCP shims bind for authorization but leave delivery to the
   *  app-server adapter. */
  receive_notifications?: boolean
}

export interface RosterEntry {
  session_id: string
  display_name: string | null
}

export interface RegisterResult {
  daemon_version: string
  protocol_version: number
  /** Daemon process start time, ISO-8601. Shim caches this and emits a
   *  `choros.daemon` `restarted` event on any subsequent register
   *  whose value differs — so the CC can frame the burst of peer-
   *  rejoin notifications that follow a daemon bounce. */
  daemon_started_at: string
  /** Buffered notifications queued while the session was offline,
   *  drained on this register call. The shim should re-emit each via
   *  mcp.notification to its CC before processing live traffic. */
  pending: { method: string; params: unknown }[]
  /** Live peers (other registered sessions with a fresh heartbeat) at
   *  the moment of this register. Lets a freshly-connected shim show
   *  "who's online" without a follow-up doctor call. */
  roster: RosterEntry[]
}

/* --- choros.deregister -------------------------------------------------- */

export interface DeregisterArgs {
  session_id: string
}

export type DeregisterResult = { acknowledged: true }

/* --- choros.heartbeat --------------------------------------------------- */

/** Periodic from shim to daemon. Carries the shim's pid + ambient
 *  agent state (status / intent) for the daemon to aggregate into the
 *  sessions table. Replaces the on-disk `.heartbeat` write. */
export interface HeartbeatArgs {
  session_id: string
  pid: number
  agent_status?: string | null
  agent_intent?: string | null
}

export type HeartbeatResult = { acknowledged: true }
