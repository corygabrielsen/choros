import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { asObject, isRpcError, optionalString, requireString } from '#choros/daemon/helpers.ts'
import { deliverOrBuffer } from '#choros/daemon/notify.ts'
import { generateMessageId } from '#choros/identity.ts'
import { enforceBodyCap, validateSpeechAct } from '#choros/inbox.ts'
import { ERR_INVALID_PARAMS, type RpcError } from '#choros/protocol/methods.ts'
import { NOTIFY_INBOUND_MESSAGE } from '#choros/protocol/notifications.ts'

export interface PublishResult {
  msg_id: string
  topic: string
  delivered_to: string[]
}

export function handlePublish(ctx: HandlerCtx, rawArgs: unknown): PublishResult | RpcError {
  const obj = asObject(rawArgs, 'publish')
  if (isRpcError(obj)) return obj

  const session_id = requireString(obj, 'session_id', 'publish')
  if (isRpcError(session_id)) return session_id
  const topic = requireString(obj, 'topic', 'publish')
  if (isRpcError(topic)) return topic
  const topicTrimmed = topic.trim()
  if (topicTrimmed.length === 0) {
    return { code: ERR_INVALID_PARAMS, message: 'publish: "topic" must be non-empty' }
  }
  const body = requireString(obj, 'body', 'publish')
  if (isRpcError(body)) return body
  try {
    enforceBodyCap(body, 'publish')
  } catch (e: unknown) {
    return { code: ERR_INVALID_PARAMS, message: e instanceof Error ? e.message : String(e) }
  }
  const actRaw = optionalString(obj, 'act', 'publish')
  if (isRpcError(actRaw)) return actRaw
  let act: string | undefined
  try {
    act = validateSpeechAct(actRaw)
  } catch (e: unknown) {
    return { code: ERR_INVALID_PARAMS, message: e instanceof Error ? e.message : String(e) }
  }

  // Subscribers minus self.
  const subscribers = (
    ctx.storage.db
      .query('SELECT session_id FROM subscriptions WHERE topic = ? AND session_id != ?')
      .all(topicTrimmed, session_id) as { session_id: string }[]
  ).map(r => r.session_id)

  const msgId = generateMessageId(session_id, ctx.nowIso())
  const senderName =
    (
      ctx.storage.db.query('SELECT display_name FROM sessions WHERE id = ?').get(session_id) as {
        display_name: string | null
      } | null
    )?.display_name ?? null

  ctx.storage.db.transaction(() => {
    const insert = ctx.storage.db.query(
      `INSERT INTO messages (id, from_session, to_session, topic, body, act, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const subId of subscribers) {
      const perSubId = `${msgId}-${subId}`
      insert.run(perSubId, session_id, subId, topicTrimmed, body, act ?? null, ctx.nowIso())
      deliverOrBuffer(ctx, subId, NOTIFY_INBOUND_MESSAGE, {
        msg_id: perSubId,
        from_session: session_id,
        from_name: senderName,
        to_session: subId,
        topic: topicTrimmed,
        body,
        ts: ctx.nowIso(),
        ...(act ? { act } : {}),
      })
    }
  })()

  return { msg_id: msgId, topic: topicTrimmed, delivered_to: subscribers }
}
