import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { asObject, isRpcError, requireString } from '#choros/daemon/helpers.ts'
import { deliverOrBuffer } from '#choros/daemon/notify.ts'
import { sanitizeId } from '#choros/identity.ts'
import { ERR_INVALID_PARAMS, type RpcError } from '#choros/protocol/methods.ts'
import { NOTIFY_REACTION } from '#choros/protocol/notifications.ts'

export interface ReactResult {
  acknowledged: true
}

export function handleReact(ctx: HandlerCtx, rawArgs: unknown): ReactResult | RpcError {
  const obj = asObject(rawArgs, 'react')
  if (isRpcError(obj)) return obj
  const session_id = requireString(obj, 'session_id', 'react')
  if (isRpcError(session_id)) return session_id
  const msg_id = requireString(obj, 'msg_id', 'react')
  if (isRpcError(msg_id)) return msg_id
  const emoji = requireString(obj, 'emoji', 'react')
  if (isRpcError(emoji)) return emoji
  try {
    sanitizeId(msg_id, 'react.msg_id')
  } catch (e: unknown) {
    return { code: ERR_INVALID_PARAMS, message: e instanceof Error ? e.message : String(e) }
  }

  // Look up the original sender to know who gets the notification.
  const orig = ctx.storage.db
    .query('SELECT from_session FROM messages WHERE id = ?')
    .get(msg_id) as { from_session: string } | null
  if (!orig) {
    return { code: ERR_INVALID_PARAMS, message: `react: unknown msg_id ${msg_id}` }
  }
  if (orig.from_session === session_id) {
    return { code: ERR_INVALID_PARAMS, message: 'react: cannot react to a message from self' }
  }

  // Upsert: same reactor reacting again replaces their prior emoji.
  ctx.storage.db
    .query(
      `INSERT INTO reactions (msg_id, by_session, emoji, reacted_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(msg_id, by_session) DO UPDATE SET emoji = excluded.emoji, reacted_at = excluded.reacted_at`,
    )
    .run(msg_id, session_id, emoji, ctx.nowIso())

  const reactorName =
    (
      ctx.storage.db.query('SELECT display_name FROM sessions WHERE id = ?').get(session_id) as {
        display_name: string | null
      } | null
    )?.display_name ?? null

  deliverOrBuffer(ctx, orig.from_session, NOTIFY_REACTION, {
    msg_id,
    by_session: session_id,
    by_name: reactorName,
    emoji,
    reacted_at: ctx.nowIso(),
  })

  return { acknowledged: true }
}
