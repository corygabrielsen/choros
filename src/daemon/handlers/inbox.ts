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
/** Byte budget for the assembled message list. Kept well under the RPC
 *  layer's 4 MiB MAX_FRAME_BYTES so the response frame can't exceed
 *  the cap and get dropped wholesale by the shim — which would defeat
 *  the recovery RPC exactly when the inbox is large. Bodies are capped
 *  at 64 KiB each, so ~48 max-size bodies fit; typical messages are
 *  far smaller. */
const INBOX_BYTE_BUDGET = 3 * 1024 * 1024

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
  /** True when more unread messages exist beyond what fit in this
   *  response (row limit or byte budget). The caller mark_read's what
   *  it consumed and pulls again to drain the rest. */
  truncated: boolean
}

export function handleInbox(ctx: HandlerCtx, rawArgs: unknown): InboxResult | RpcError {
  const obj = asObject(rawArgs, 'inbox')
  if (isRpcError(obj)) return obj
  const session_id = requireString(obj, 'session_id', 'inbox')
  if (isRpcError(session_id)) return session_id
  const limitArg = optionalNumber(obj, 'limit', 'inbox')
  if (isRpcError(limitArg)) return limitArg
  const limit =
    limitArg === undefined
      ? INBOX_DEFAULT_LIMIT
      : Math.min(Math.max(1, Math.trunc(limitArg)), INBOX_MAX_LIMIT)

  // Fetch one extra row to detect row-limit truncation without a
  // second COUNT query. Stable order: ts then id (ts is TEXT and id is
  // non-monotonic, so ts alone leaves equal-ts rows in arbitrary order
  // — unstable paging).
  const rows = ctx.storage.db
    .query(
      `SELECT m.id AS msg_id, m.from_session, s.display_name AS from_name,
              m.body, m.act, m.topic, m.thread_id, m.in_reply_to, m.ts, m.delivered_at
       FROM messages m
       LEFT JOIN sessions s ON s.id = m.from_session
       WHERE m.to_session = ? AND m.read_at IS NULL
       ORDER BY m.ts ASC, m.id ASC
       LIMIT ?`,
    )
    .all(session_id, limit + 1) as InboxMessage[]

  let truncated = rows.length > limit
  const capped = truncated ? rows.slice(0, limit) : rows

  // Enforce the byte budget so the response frame stays under
  // MAX_FRAME_BYTES. Always include at least one message (a single
  // 64 KiB body is well under budget) so a large head-of-queue
  // message can still be drained one at a time.
  const messages: InboxMessage[] = []
  let bytes = 0
  for (const m of capped) {
    const size = Buffer.byteLength(m.body, 'utf8') + 256
    if (messages.length > 0 && bytes + size > INBOX_BYTE_BUDGET) {
      truncated = true
      break
    }
    messages.push(m)
    bytes += size
  }
  return { messages, truncated }
}
