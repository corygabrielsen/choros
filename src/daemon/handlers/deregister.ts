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
 *  row stays for history) and drops the routing binding.
 *
 *  Presence broadcast is routed through the renewal coordinator: when
 *  the session held a display name, the `leave` is deferred for
 *  RENEWAL_WINDOW_MS so a same-name reclaim within the window coalesces
 *  into a single `session_renewed` event. Sessions without a display
 *  name skip the deferral and emit `leave` immediately. Sessions that
 *  disconnect while still in `Pending` join (joined-in-name-only, never
 *  confirmed) drop silently — no leave is ever broadcast for an
 *  identity that was never broadcast as joined. */
export function handleDeregister(ctx: HandlerCtx, rawArgs: unknown): DeregisterResult | RpcError {
  const parsed = validateDeregisterArgs(rawArgs)
  if ('code' in parsed) return parsed
  const displayName = ctx.router.displayNameFor(parsed.session_id) ?? null
  // Flush any still-pending join in front of the leave so the
  // observable sequence is `join → leave` for a came-and-went session
  // rather than just `leave` for an unannounced one. The renewal
  // path can still coalesce a subsequent same-name claim; flushing
  // join here doesn't preempt that — it only affects the timing of
  // the broadcast for this session's own join.
  ctx.renewal.flushPendingJoinIfAny(ctx, parsed.session_id)
  ctx.renewal.enterPendingLeave(ctx, parsed.session_id, displayName)
  clearSessionLock(ctx.storage, parsed.session_id)
  ctx.router.unbindBySession(parsed.session_id)
  return { acknowledged: true }
}
