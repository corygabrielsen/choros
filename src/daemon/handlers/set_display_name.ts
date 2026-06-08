import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import {
  asObject,
  DISPLAY_NAME_MAX_BYTES,
  isRpcError,
  optionalString,
  requireString,
} from '#choros/daemon/helpers.ts'
import { broadcastPresence, evictDisplayNameHolders } from '#choros/daemon/notify.ts'
import { broadcastSessionRenewed } from '#choros/daemon/renewal.ts'
import { ERR_UNKNOWN_SESSION, type RpcError } from '#choros/protocol/methods.ts'

export interface SetDisplayNameResult {
  display_name: string | null
}

export function handleSetDisplayName(
  ctx: HandlerCtx,
  rawArgs: unknown,
): SetDisplayNameResult | RpcError {
  const obj = asObject(rawArgs, 'set_display_name')
  if (isRpcError(obj)) return obj
  const session_id = requireString(obj, 'session_id', 'set_display_name')
  if (isRpcError(session_id)) return session_id
  const display_name = optionalString(
    obj,
    'display_name',
    'set_display_name',
    DISPLAY_NAME_MAX_BYTES,
  )
  if (isRpcError(display_name)) return display_name

  const value: string | null =
    display_name === undefined || display_name.length === 0 ? null : display_name

  // Prior name (cached) so a real change can be announced to live peers.
  const cached = ctx.router.displayNameFor(session_id)
  const previous = cached === undefined ? null : cached

  // Renewal check: a freshly-registered session (`Pending` join)
  // claiming a recently-vacated name (`PendingLeave`) collapses the
  // (leave, join, name_evicted, rename) sequence into one
  // `session_renewed` event. Only attempted on a non-null claim; a
  // session clearing its own name is never a renewal.
  const renewal =
    value === null ? { kind: 'normal' as const } : ctx.renewal.tryRenewal(value, session_id)

  // Claim the name from any prior holder before writing it to this
  // session. On the renewal path the eviction still runs (clearing
  // the old row's display_name in the DB) but its name_evicted
  // broadcast is suppressed — the session_renewed event that fires
  // below is the composite witness that already conveys the
  // ownership transfer.
  if (value !== null) {
    evictDisplayNameHolders(ctx, value, session_id, {
      suppressBroadcast: renewal.kind === 'renewed',
    })
  }

  const result = ctx.storage.db
    .query('UPDATE sessions SET display_name = ? WHERE id = ?')
    .run(value, session_id)
  if (result.changes === 0) {
    // Mirrors set_status / set_intent / heartbeat — explicit error on
    // unknown session rather than a silent success that masks a stale
    // shim still trying to rename a deregistered session row.
    return { code: ERR_UNKNOWN_SESSION, message: 'set_display_name: unknown session' }
  }
  ctx.router.setDisplayName(session_id, value)

  if (renewal.kind === 'renewed' && value !== null) {
    // Coalesced path: one event in place of leave + join + name_evicted
    // + rename. The eviction above ran with broadcast suppressed; the
    // pending join + pending leave were cancelled inside tryRenewal.
    // session_renewed is the composite witness consumers see.
    broadcastSessionRenewed(ctx, renewal.oldSessionId, session_id, value)
  } else {
    // Normal path: flush any deferred join for this session so live
    // peers see `join` before `rename` (correct causal order) rather
    // than `rename` for an unannounced session. Then broadcast rename
    // if the value actually changed.
    ctx.renewal.flushPendingJoinIfAny(ctx, session_id)
    if (previous !== value) {
      broadcastPresence(ctx, 'rename', session_id, value, previous)
    }
  }
  return { display_name: value }
}
