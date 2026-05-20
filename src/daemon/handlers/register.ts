import { LIVE_MAX_AGE_MS } from '#choros/constants.ts'
import { DISPLAY_NAME_MAX_BYTES, nowMsFromCtx } from '#choros/daemon/helpers.ts'
import { broadcastPresence } from '#choros/daemon/notify.ts'
import type { NotificationSink, SessionRouter } from '#choros/daemon/sessions.ts'
import type { Storage } from '#choros/daemon/storage.ts'
import { drainPendingNotifications, upsertSession } from '#choros/daemon/storage.ts'
import {
  ERR_INVALID_PARAMS,
  ERR_PROTOCOL_MISMATCH,
  PROTOCOL_VERSION,
  type RegisterArgs,
  type RegisterResult,
  type RpcError,
} from '#choros/protocol/methods.ts'

/** Daemon-side build metadata returned in the register handshake. The
 *  shim doesn't depend on it for correctness — it's purely diagnostic. */
export interface DaemonIdentity {
  version: string
}

/** Handler context — what every RPC method needs. */
export interface HandlerCtx {
  storage: Storage
  router: SessionRouter
  daemon: DaemonIdentity
  nowIso(): string
}

function validateRegisterArgs(args: unknown): RpcError | RegisterArgs {
  if (!args || typeof args !== 'object') {
    return { code: ERR_INVALID_PARAMS, message: 'register: params must be an object' }
  }
  const a = args as Record<string, unknown>
  if (typeof a.protocol_version !== 'number') {
    return { code: ERR_INVALID_PARAMS, message: 'register: protocol_version must be a number' }
  }
  if (typeof a.session_id !== 'string' || a.session_id.length === 0) {
    return { code: ERR_INVALID_PARAMS, message: 'register: session_id required' }
  }
  if (a.display_name !== null && typeof a.display_name !== 'string') {
    return { code: ERR_INVALID_PARAMS, message: 'register: display_name must be string or null' }
  }
  if (
    typeof a.display_name === 'string' &&
    Buffer.byteLength(a.display_name, 'utf8') > DISPLAY_NAME_MAX_BYTES
  ) {
    return {
      code: ERR_INVALID_PARAMS,
      message: `register: display_name exceeds ${DISPLAY_NAME_MAX_BYTES} bytes`,
    }
  }
  if (typeof a.host !== 'string') {
    return { code: ERR_INVALID_PARAMS, message: 'register: host must be a string' }
  }
  if (typeof a.cwd !== 'string') {
    return { code: ERR_INVALID_PARAMS, message: 'register: cwd must be a string' }
  }
  if (typeof a.pid !== 'number' || !Number.isFinite(a.pid)) {
    return { code: ERR_INVALID_PARAMS, message: 'register: pid must be a finite number' }
  }
  return a as unknown as RegisterArgs
}

/** Shim → daemon handshake. Registers the session in SQLite, binds
 *  the connection's notification sink, and drains any notifications
 *  buffered while the session was offline. */
export function handleRegister(
  ctx: HandlerCtx,
  sink: NotificationSink,
  rawArgs: unknown,
): RegisterResult | RpcError {
  const parsed = validateRegisterArgs(rawArgs)
  if ('code' in parsed) return parsed
  if (parsed.protocol_version !== PROTOCOL_VERSION) {
    return {
      code: ERR_PROTOCOL_MISMATCH,
      message: `register: protocol mismatch — shim ${parsed.protocol_version}, daemon ${PROTOCOL_VERSION}; reinstall the matching shim binary`,
    }
  }
  upsertSession(ctx.storage, {
    id: parsed.session_id,
    display_name: parsed.display_name,
    host: parsed.host,
    cwd: parsed.cwd,
    pid: parsed.pid,
    nowIso: ctx.nowIso(),
  })
  ctx.router.bind(parsed.session_id, sink, parsed.display_name)
  const pending = drainPendingNotifications(ctx.storage, parsed.session_id)

  // Roster: other registered sessions with a fresh heartbeat. Returned
  // so the freshly-connected shim can show "who's online" without a
  // follow-up doctor call.
  const liveCutoff = new Date(nowMsFromCtx(ctx) - LIVE_MAX_AGE_MS).toISOString()
  const roster = ctx.storage.db
    .query(
      `SELECT id AS session_id, display_name FROM sessions
       WHERE id != ? AND lock_pid IS NOT NULL AND heartbeat_at >= ?
       ORDER BY heartbeat_at DESC NULLS LAST`,
    )
    .all(parsed.session_id, liveCutoff) as RegisterResult['roster']

  // Tell the live peers this session arrived (push-only, post-bind so
  // the joiner itself is excluded by connectedSessionIds).
  broadcastPresence(ctx, 'join', parsed.session_id, parsed.display_name)

  return {
    daemon_version: ctx.daemon.version,
    protocol_version: PROTOCOL_VERSION,
    pending,
    roster,
  }
}
