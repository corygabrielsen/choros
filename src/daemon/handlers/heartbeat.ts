import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { recordHeartbeat } from '#choros/daemon/storage.ts'
import {
  ERR_INVALID_PARAMS,
  ERR_UNKNOWN_SESSION,
  type HeartbeatArgs,
  type HeartbeatResult,
  type RpcError,
} from '#choros/protocol/methods.ts'

function validateHeartbeatArgs(args: unknown): RpcError | HeartbeatArgs {
  if (!args || typeof args !== 'object') {
    return { code: ERR_INVALID_PARAMS, message: 'heartbeat: params must be an object' }
  }
  const a = args as Record<string, unknown>
  if (typeof a.session_id !== 'string' || a.session_id.length === 0) {
    return { code: ERR_INVALID_PARAMS, message: 'heartbeat: session_id required' }
  }
  if (typeof a.pid !== 'number' || !Number.isFinite(a.pid)) {
    return { code: ERR_INVALID_PARAMS, message: 'heartbeat: pid required' }
  }
  if (
    a.agent_status !== undefined &&
    a.agent_status !== null &&
    typeof a.agent_status !== 'string'
  ) {
    return { code: ERR_INVALID_PARAMS, message: 'heartbeat: agent_status must be string or null' }
  }
  if (
    a.agent_intent !== undefined &&
    a.agent_intent !== null &&
    typeof a.agent_intent !== 'string'
  ) {
    return { code: ERR_INVALID_PARAMS, message: 'heartbeat: agent_intent must be string or null' }
  }
  return a as unknown as HeartbeatArgs
}

/** Periodic shim → daemon ping. Refreshes heartbeat_at + lock_pid +
 *  ambient agent state. Returns ERR_UNKNOWN_SESSION when the session
 *  was deregistered (or never registered) so the shim re-registers
 *  rather than continuing to ping into the void. */
export function handleHeartbeat(ctx: HandlerCtx, rawArgs: unknown): HeartbeatResult | RpcError {
  const parsed = validateHeartbeatArgs(rawArgs)
  if ('code' in parsed) return parsed
  const updated = recordHeartbeat(ctx.storage, {
    session_id: parsed.session_id,
    pid: parsed.pid,
    agent_status: parsed.agent_status ?? null,
    agent_intent: parsed.agent_intent ?? null,
    nowIso: ctx.nowIso(),
  })
  if (!updated) {
    return {
      code: ERR_UNKNOWN_SESSION,
      message: 'heartbeat: session not registered (re-register required)',
    }
  }
  return { acknowledged: true }
}
