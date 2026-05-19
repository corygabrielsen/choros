import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { asObject, isRpcError, optionalString, requireString } from '#choros/daemon/helpers.ts'
import { ERR_INVALID_PARAMS, type RpcError } from '#choros/protocol/methods.ts'

export interface SetDisplayNameResult {
  display_name: string | null
}

/** Maximum chars for a display name. Names appear in every meta blob
 *  and channel notification — an uncapped value would let a shim pump
 *  arbitrary bytes through every recipient's CC log. */
const DISPLAY_NAME_MAX = 256

export function handleSetDisplayName(
  ctx: HandlerCtx,
  rawArgs: unknown,
): SetDisplayNameResult | RpcError {
  const obj = asObject(rawArgs, 'set_display_name')
  if (isRpcError(obj)) return obj
  const session_id = requireString(obj, 'session_id', 'set_display_name')
  if (isRpcError(session_id)) return session_id
  const display_name = optionalString(obj, 'display_name', 'set_display_name')
  if (isRpcError(display_name)) return display_name

  let value: string | null
  if (display_name === undefined) {
    value = null
  } else if (display_name.length === 0) {
    value = null
  } else if (display_name.length > DISPLAY_NAME_MAX) {
    return {
      code: ERR_INVALID_PARAMS,
      message: `set_display_name: exceeds ${DISPLAY_NAME_MAX} characters`,
    }
  } else {
    value = display_name
  }

  ctx.storage.db.query('UPDATE sessions SET display_name = ? WHERE id = ?').run(value, session_id)
  ctx.router.setDisplayName(session_id, value)
  return { display_name: value }
}
