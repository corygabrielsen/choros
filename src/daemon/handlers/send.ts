import { LIVE_MAX_AGE_MS } from '#choros/constants.ts'
import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import {
  asObject,
  cachedSenderName,
  isRpcError,
  nowMsFromCtx,
  optionalString,
  requireString,
  resolveRecipient,
} from '#choros/daemon/helpers.ts'
import { deliverOrBuffer } from '#choros/daemon/notify.ts'
import { generateMessageId, sanitizeId } from '#choros/identity.ts'
import { BODY_CAP_BYTES, enforceBodyCap, validateSpeechAct } from '#choros/inbox.ts'
import { ERR_INVALID_PARAMS, type RpcError } from '#choros/protocol/methods.ts'
import { NOTIFY_INBOUND_MESSAGE } from '#choros/protocol/notifications.ts'

export interface SendResult {
  msg_id: string
  recipient_id: string
  recipient_name: string | null
  live_status: 'live' | 'stale' | 'wedged' | 'unknown'
  heartbeat_age_ms: number | null
}

interface SendParsed {
  session_id: string
  to: string
  body: string
  act?: string | undefined
  in_reply_to?: string | undefined
  msg_id?: string | undefined
}

function parseSendArgs(rawArgs: unknown): SendParsed | RpcError {
  const obj = asObject(rawArgs, 'send')
  if (isRpcError(obj)) return obj
  const session_id = requireString(obj, 'session_id', 'send')
  if (isRpcError(session_id)) return session_id
  const to = requireString(obj, 'to', 'send')
  if (isRpcError(to)) return to
  const body = requireString(obj, 'body', 'send', BODY_CAP_BYTES)
  if (isRpcError(body)) return body
  try {
    enforceBodyCap(body, 'send')
  } catch (e: unknown) {
    return { code: ERR_INVALID_PARAMS, message: e instanceof Error ? e.message : String(e) }
  }
  const actRaw = optionalString(obj, 'act', 'send')
  if (isRpcError(actRaw)) return actRaw
  let act: string | undefined
  try {
    act = validateSpeechAct(actRaw)
  } catch (e: unknown) {
    return { code: ERR_INVALID_PARAMS, message: e instanceof Error ? e.message : String(e) }
  }
  const replyTo = optionalString(obj, 'in_reply_to', 'send')
  if (isRpcError(replyTo)) return replyTo
  const msgIdRaw = optionalString(obj, 'msg_id', 'send')
  if (isRpcError(msgIdRaw)) return msgIdRaw
  let msg_id: string | undefined
  if (msgIdRaw !== undefined) {
    try {
      msg_id = sanitizeId(msgIdRaw, 'send.msg_id')
    } catch (e: unknown) {
      return { code: ERR_INVALID_PARAMS, message: e instanceof Error ? e.message : String(e) }
    }
  }
  return { session_id, to, body, act, in_reply_to: replyTo, msg_id }
}

function snapshotLiveness(
  ctx: HandlerCtx,
  recipientId: string,
): { live_status: SendResult['live_status']; heartbeat_age_ms: number | null } {
  const peer = ctx.storage.db
    .query('SELECT heartbeat_at, lock_pid, wedged_at FROM sessions WHERE id = ?')
    .get(recipientId) as {
    heartbeat_at: string | null
    lock_pid: number | null
    wedged_at: string | null
  } | null
  const now = nowMsFromCtx(ctx)
  const age = peer?.heartbeat_at ? now - Date.parse(peer.heartbeat_at) : null
  if (age === null) return { live_status: 'unknown', heartbeat_age_ms: null }
  if (peer?.wedged_at) return { live_status: 'wedged', heartbeat_age_ms: age }
  if (age <= LIVE_MAX_AGE_MS && peer?.lock_pid !== null) {
    return { live_status: 'live', heartbeat_age_ms: age }
  }
  return { live_status: 'stale', heartbeat_age_ms: age }
}

export function handleSend(ctx: HandlerCtx, rawArgs: unknown): SendResult | RpcError {
  const parsed = parseSendArgs(rawArgs)
  if (isRpcError(parsed)) return parsed

  const recipient = resolveRecipient(ctx, parsed.to.trim())
  if (isRpcError(recipient)) return recipient
  if (recipient.id === parsed.session_id) {
    return { code: ERR_INVALID_PARAMS, message: 'send: cannot send to self' }
  }

  // Memoize the per-call ISO timestamp so the inserted row and the
  // recipient's notification share the same ts. Calling ctx.nowIso()
  // three times also allocates 3 Date objects for nothing.
  const ts = ctx.nowIso()
  const msgId = parsed.msg_id ?? generateMessageId(parsed.session_id, ts)
  const replyTrim = parsed.in_reply_to?.trim() || null

  ctx.storage.db
    .query(
      `INSERT INTO messages (id, from_session, to_session, body, act, in_reply_to, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(msgId, parsed.session_id, recipient.id, parsed.body, parsed.act ?? null, replyTrim, ts)

  const senderName = cachedSenderName(ctx, parsed.session_id)

  deliverOrBuffer(ctx, recipient.id, NOTIFY_INBOUND_MESSAGE, {
    msg_id: msgId,
    from_session: parsed.session_id,
    from_name: senderName,
    to_session: recipient.id,
    body: parsed.body,
    ts,
    ...(parsed.act ? { act: parsed.act } : {}),
    ...(replyTrim ? { in_reply_to: replyTrim } : {}),
  })

  const liveness = snapshotLiveness(ctx, recipient.id)
  return {
    msg_id: msgId,
    recipient_id: recipient.id,
    recipient_name: recipient.display_name,
    live_status: liveness.live_status,
    heartbeat_age_ms: liveness.heartbeat_age_ms,
  }
}
