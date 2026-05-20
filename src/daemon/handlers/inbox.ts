import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { asObject, isRpcError, optionalNumber, requireString } from '#choros/daemon/helpers.ts'
import type { RpcError } from '#choros/protocol/methods.ts'

/** Pull the caller's unread messages. This is the recovery path for a
 *  push that CC silently dropped: inbound delivery is push-only, so
 *  without a pull a dropped notification's body was unrecoverable.
 *  Returns rows addressed to the caller (direct, broadcast, topic, and
 *  thread fan-out all write a per-recipient row with to_session = me)
 *  that haven't been mark_read'd. Read-only — does not mutate
 *  delivered_at/read_at; mark_read owns that. */

const INBOX_DEFAULT_LIMIT = 100
const INBOX_MAX_LIMIT = 500

export interface InboxMessage {
  msg_id: string
  from_session: string
  from_name: string | null
  body: string
  act: string | null
  topic: string | null
  thread_id: string | null
  in_reply_to: string | null
  ts: string
  delivered_at: string | null
}

export interface InboxResult {
  messages: InboxMessage[]
}

export function handleInbox(ctx: HandlerCtx, rawArgs: unknown): InboxResult | RpcError {
  const obj = asObject(rawArgs, 'inbox')
  if (isRpcError(obj)) return obj
  const session_id = requireString(obj, 'session_id', 'inbox')
  if (isRpcError(session_id)) return session_id
  const limitArg = optionalNumber(obj, 'limit', 'inbox')
  if (isRpcError(limitArg)) return limitArg
  const limit =
    limitArg === undefined ? INBOX_DEFAULT_LIMIT : Math.min(Math.max(1, limitArg), INBOX_MAX_LIMIT)

  const messages = ctx.storage.db
    .query(
      `SELECT m.id AS msg_id, m.from_session, s.display_name AS from_name,
              m.body, m.act, m.topic, m.thread_id, m.in_reply_to, m.ts, m.delivered_at
       FROM messages m
       LEFT JOIN sessions s ON s.id = m.from_session
       WHERE m.to_session = ? AND m.read_at IS NULL
       ORDER BY m.ts ASC
       LIMIT ?`,
    )
    .all(session_id, limit) as InboxMessage[]
  return { messages }
}
