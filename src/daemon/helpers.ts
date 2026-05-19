import { LIVE_MAX_AGE_MS } from '#choros/constants.ts'
import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { UUID_RE } from '#choros/identity.ts'
import { ERR_INVALID_PARAMS, ERR_UNKNOWN_SESSION, type RpcError } from '#choros/protocol/methods.ts'

/** Generic "args object" coercion used by every handler. */
export function asObject(args: unknown, label: string): Record<string, unknown> | RpcError {
  if (!args || typeof args !== 'object') {
    return { code: ERR_INVALID_PARAMS, message: `${label}: params must be an object` }
  }
  return args as Record<string, unknown>
}

/** Default maximum byte length for string fields. Tight enough that
 *  no single field can pump multi-MB into the channel meta or grow a
 *  row past reasonable bounds; loose enough that legitimate input
 *  (agent_status, agent_intent, host, cwd) fits. Per-handler overrides
 *  pick tighter caps where appropriate (display_name, emoji, topic). */
export const DEFAULT_STRING_MAX = 8 * 1024

/** Require a non-empty string field. Enforces a byte-length cap via
 *  `maxBytes` (default {@link DEFAULT_STRING_MAX}) so a malicious or
 *  buggy shim cannot ship multi-MB strings into row columns. */
export function requireString(
  obj: Record<string, unknown>,
  field: string,
  label: string,
  maxBytes: number = DEFAULT_STRING_MAX,
): string | RpcError {
  const v = obj[field]
  if (typeof v !== 'string' || v.length === 0) {
    return { code: ERR_INVALID_PARAMS, message: `${label}: "${field}" is required` }
  }
  if (Buffer.byteLength(v, 'utf8') > maxBytes) {
    return {
      code: ERR_INVALID_PARAMS,
      message: `${label}: "${field}" exceeds ${maxBytes} bytes`,
    }
  }
  return v
}

/** Optional string field. Same length cap rules as `requireString`. */
export function optionalString(
  obj: Record<string, unknown>,
  field: string,
  label: string,
  maxBytes: number = DEFAULT_STRING_MAX,
): string | undefined | RpcError {
  const v = obj[field]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') {
    return { code: ERR_INVALID_PARAMS, message: `${label}: "${field}" must be a string` }
  }
  if (Buffer.byteLength(v, 'utf8') > maxBytes) {
    return {
      code: ERR_INVALID_PARAMS,
      message: `${label}: "${field}" exceeds ${maxBytes} bytes`,
    }
  }
  return v
}

/** Optional boolean field. */
export function optionalNumber(
  obj: Record<string, unknown>,
  field: string,
  label: string,
): number | undefined | RpcError {
  const v = obj[field]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return { code: ERR_INVALID_PARAMS, message: `${label}: "${field}" must be a finite number` }
  }
  return v
}

export function isRpcError(v: unknown): v is RpcError {
  return (
    typeof v === 'object' &&
    v !== null &&
    'code' in (v as object) &&
    'message' in (v as object) &&
    typeof (v as RpcError).code === 'number'
  )
}

/* --- Liveness ---------------------------------------------------------- */

/** A peer is live iff it has a fresh heartbeat AND its shim is currently
 *  connected (lock_pid is non-null AND the SessionRouter has a sink for
 *  it). The router check is what distinguishes "shim cleanly
 *  deregistered" from "shim crashed mid-session." */
export function isLive(ctx: HandlerCtx, sessionId: string, nowMs: number): boolean {
  const row = ctx.storage.db
    .query('SELECT heartbeat_at, lock_pid FROM sessions WHERE id = ?')
    .get(sessionId) as { heartbeat_at: string | null; lock_pid: number | null } | null
  if (!row?.heartbeat_at || row.lock_pid === null) return false
  const age = nowMs - Date.parse(row.heartbeat_at)
  if (age > LIVE_MAX_AGE_MS) return false
  return ctx.router.sinkFor(sessionId) !== null
}

/** Resolve a recipient handle (display name, UUID, or UUID prefix) to
 *  a single session row. Ambiguity is broken by most-recent
 *  heartbeat_at; a UUID-shaped non-match falls through to "create the
 *  row on demand" (which the caller does by writing into the messages
 *  table — the FK on `messages.from_session`/`to_session` is intentionally
 *  loose because peers come and go). */
export function resolveRecipient(
  ctx: HandlerCtx,
  target: string,
): { id: string; display_name: string | null } | RpcError {
  // Exact UUID
  if (UUID_RE.test(target)) {
    const row = ctx.storage.db
      .query('SELECT id, display_name FROM sessions WHERE id = ?')
      .get(target) as { id: string; display_name: string | null } | null
    if (row) return row
    // Unknown but UUID-shaped — return it as the "synthetic" target so
    // the caller can write a message to it; the session row is created
    // on first register.
    return { id: target, display_name: null }
  }
  // Display-name match. Prefer the most-recent heartbeat.
  const byName = ctx.storage.db
    .query(
      `SELECT id, display_name FROM sessions
       WHERE display_name = ? ORDER BY heartbeat_at DESC NULLS LAST LIMIT 1`,
    )
    .get(target) as { id: string; display_name: string | null } | null
  if (byName) return byName
  // UUID prefix match (must be unambiguous).
  const prefix = ctx.storage.db
    .query('SELECT id, display_name FROM sessions WHERE id LIKE ? LIMIT 2')
    .all(`${target}%`) as { id: string; display_name: string | null }[]
  if (prefix.length === 1 && prefix[0]) return prefix[0]
  if (prefix.length > 1) {
    return {
      code: ERR_INVALID_PARAMS,
      message: `ambiguous recipient "${target}" — matches multiple session prefixes`,
    }
  }
  return {
    code: ERR_UNKNOWN_SESSION,
    message: `unknown recipient: ${target}`,
  }
}

/** Now-ms helper that matches HandlerCtx.nowIso for consistency. */
export function nowMsFromCtx(ctx: HandlerCtx): number {
  return Date.parse(ctx.nowIso())
}
