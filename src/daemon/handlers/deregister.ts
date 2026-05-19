import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { clearSessionLock } from '#choros/daemon/storage.ts'
import {
  type DeregisterArgs,
  type DeregisterResult,
  ERR_INVALID_PARAMS,
  type RpcError,
} from '#choros/protocol/methods.ts'

function validateDeregisterArgs(args: unknown): RpcError | DeregisterArgs {
  if (!args || typeof args !== 'object') {
    return { code: ERR_INVALID_PARAMS, message: 'deregister: params must be an object' }
  }
  const a = args as Record<string, unknown>
  if (typeof a.session_id !== 'string' || a.session_id.length === 0) {
    return { code: ERR_INVALID_PARAMS, message: 'deregister: session_id required' }
  }
  return a as unknown as DeregisterArgs
}

/** Shim → daemon clean shutdown. Clears the session's lock_pid (the
 *  row stays for history) and drops the routing binding. */
export function handleDeregister(ctx: HandlerCtx, rawArgs: unknown): DeregisterResult | RpcError {
  const parsed = validateDeregisterArgs(rawArgs)
  if ('code' in parsed) return parsed
  clearSessionLock(ctx.storage, parsed.session_id)
  ctx.router.unbindBySession(parsed.session_id)
  return { acknowledged: true }
}
