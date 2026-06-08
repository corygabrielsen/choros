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

  // Renewal recognition: if the claimed name is in the vacated cache
  // (its prior holder deregistered within VACATED_TTL_MS), emit a
  // single `session_renewed` witness and suppress the standard
  // name_evicted + rename pair. The atomic `leave(prior_session)`
  // already fired at deregister time; the witness retroactively
  // frames it as the departure half of an identity transition.
  const renewal =
    value === null ? { kind: 'normal' as const } : ctx.renewal.tryRecognizeRenewal(value)

  // Claim the name from any prior LIVE holder. On the renewal path
  // the prior holder already deregistered; if its row still carries
  // the display_name in the DB (deregister preserves history rows),
  // the eviction clears it without broadcasting — the
  // session_renewed witness conveys the ownership transfer.
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
    // Witness path: one session_renewed event in place of name_evicted
    // + rename. The preceding `leave(prior_session)` fired
    // immediately at deregister time; the witness frames the pair.
    broadcastSessionRenewed(ctx, renewal.oldSessionId, session_id, value)
  } else if (previous !== value) {
    // Standard path: announce the rename so live peers update without
    // waiting for a doctor, the renamer's next message, or a
    // leave/join cycle. Push-only; skip no-op writes that didn't
    // actually change the name.
    broadcastPresence(ctx, 'rename', session_id, value, previous)
  }
  return { display_name: value }
}
