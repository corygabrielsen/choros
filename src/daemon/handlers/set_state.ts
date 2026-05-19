import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { asObject, isRpcError, optionalString, requireString } from '#choros/daemon/helpers.ts'
import { ERR_INVALID_PARAMS, ERR_UNKNOWN_SESSION, type RpcError } from '#choros/protocol/methods.ts'

export interface SetStateResult {
  status?: string | null
  intent?: string | null
}

function parseArgs(
  rawArgs: unknown,
  field: 'agent_status' | 'agent_intent',
): { session_id: string; text: string } | RpcError {
  const obj = asObject(rawArgs, field)
  if (isRpcError(obj)) return obj
  const session_id = requireString(obj, 'session_id', field)
  if (isRpcError(session_id)) return session_id
  // Empty text clears the field; that's a legal value, not a missing one.
  const text = optionalString(obj, 'text', field)
  if (isRpcError(text)) return text
  if (text === undefined) {
    return { code: ERR_INVALID_PARAMS, message: `${field}: "text" is required (empty to clear)` }
  }
  return { session_id, text }
}

export function handleSetStatus(ctx: HandlerCtx, rawArgs: unknown): SetStateResult | RpcError {
  const parsed = parseArgs(rawArgs, 'agent_status')
  if (isRpcError(parsed)) return parsed
  const value = parsed.text.length === 0 ? null : parsed.text
  // Surface "unknown session" instead of silently no-op'ing. Same
  // predicate the heartbeat handler now uses; previously a stale
  // shim calling set_status for a deregistered/never-registered
  // session got an opaque success.
  const result = ctx.storage.db
    .query('UPDATE sessions SET agent_status = ? WHERE id = ?')
    .run(value, parsed.session_id)
  if (result.changes === 0) {
    return { code: ERR_UNKNOWN_SESSION, message: 'set_status: unknown session' }
  }
  return { status: value }
}

export function handleSetIntent(ctx: HandlerCtx, rawArgs: unknown): SetStateResult | RpcError {
  const parsed = parseArgs(rawArgs, 'agent_intent')
  if (isRpcError(parsed)) return parsed
  const value = parsed.text.length === 0 ? null : parsed.text
  const result = ctx.storage.db
    .query('UPDATE sessions SET agent_intent = ? WHERE id = ?')
    .run(value, parsed.session_id)
  if (result.changes === 0) {
    return { code: ERR_UNKNOWN_SESSION, message: 'set_intent: unknown session' }
  }
  return { intent: value }
}
