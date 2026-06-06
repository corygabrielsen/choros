import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import {
  asObject,
  DISPLAY_NAME_MAX_BYTES,
  isRpcError,
  optionalString,
  requireString,
} from '#choros/daemon/helpers.ts'
import { broadcastPresence, evictDisplayNameHolders } from '#choros/daemon/notify.ts'
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

  // Claim the name from any prior holder before writing it to this
  // session — so the post-write read of `display_name` returns this
  // session unambiguously.
  if (value !== null) {
    evictDisplayNameHolders(ctx, value, session_id)
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

  // Announce the rename so live peers update without waiting for a doctor,
  // the renamer's next message, or a leave/join cycle. Push-only; skip
  // no-op writes that didn't actually change the name.
  if (previous !== value) {
    broadcastPresence(ctx, 'rename', session_id, value, previous)
  }
  return { display_name: value }
}
