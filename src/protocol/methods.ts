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
export const PROTOCOL_VERSION = 1

/** Standard JSON-RPC 2.0 request envelope. */
export interface RpcRequest<P = unknown> {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: P
}

/** Standard JSON-RPC 2.0 response envelope. Exactly one of `result`
 *  or `error` is present. */
export type RpcResponse<R = unknown> =
  | { jsonrpc: '2.0'; id: number | string; result: R }
  | { jsonrpc: '2.0'; id: number | string; error: RpcError }

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
}

export interface RegisterResult {
  daemon_version: string
  protocol_version: number
  /** Buffered notifications queued while the session was offline,
   *  drained on this register call. The shim should re-emit each via
   *  mcp.notification to its CC before processing live traffic. */
  pending: { method: string; params: unknown }[]
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
