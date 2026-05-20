import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import {
  asObject,
  cachedSenderName,
  isRpcError,
  optionalString,
  requireString,
} from '#choros/daemon/helpers.ts'
import { deliverOrBuffer } from '#choros/daemon/notify.ts'
import { generateMessageId } from '#choros/identity.ts'
import { BODY_CAP_BYTES, enforceBodyCap, validateSpeechAct } from '#choros/inbox.ts'
import { ERR_INVALID_PARAMS, type RpcError } from '#choros/protocol/methods.ts'
import { NOTIFY_INBOUND_MESSAGE } from '#choros/protocol/notifications.ts'

export interface PublishResult {
  /** Null when the topic has no subscribers; nothing is persisted in
   *  that case so a follow-up react against a fabricated id would
   *  fail. The caller treats null as "noone heard this." */
  msg_id: string | null
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
  // Match subscribe()'s canonicalization so `publish('FOO')` reaches
  // `subscribe('foo')`. Topics are channel names.
  const topicTrimmed = topic.trim().toLowerCase()
  if (topicTrimmed.length === 0) {
    return { code: ERR_INVALID_PARAMS, message: 'publish: "topic" must be non-empty' }
  }
  const body = requireString(obj, 'body', 'publish', BODY_CAP_BYTES)
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

  if (subscribers.length === 0) {
    return { msg_id: null, topic: topicTrimmed, delivered_to: [] }
  }

  const msgId = generateMessageId(session_id, ctx.nowIso())
  const senderName = cachedSenderName(ctx, session_id)

  const ts = ctx.nowIso()
  const perSubIds = subscribers.map(subId => ({ subId, perSubId: `${msgId}-${subId}` }))

  ctx.storage.db.transaction(() => {
    const insert = ctx.storage.db.query(
      `INSERT INTO messages (id, from_session, to_session, topic, body, act, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const { perSubId, subId } of perSubIds) {
      insert.run(perSubId, session_id, subId, topicTrimmed, body, act ?? null, ts)
    }
  })()

  // Fan out notifications AFTER commit; otherwise the WAL writer
  // lock is held across N socket writes.
  for (const { perSubId, subId } of perSubIds) {
    deliverOrBuffer(ctx, subId, NOTIFY_INBOUND_MESSAGE, {
      msg_id: perSubId,
      from_session: session_id,
      from_name: senderName,
      to_session: subId,
      topic: topicTrimmed,
      body,
      ts,
      ...(act ? { act } : {}),
    })
  }

  return { msg_id: msgId, topic: topicTrimmed, delivered_to: subscribers }
}
