import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import {
  asObject,
  cachedSenderName,
  isRpcError,
  optionalString,
  requireString,
} from '#choros/daemon/helpers.ts'
import { deliverOrBuffer } from '#choros/daemon/notify.ts'
import { generateMessageId, sanitizeId } from '#choros/identity.ts'
import { enforceBodyCap, validateSpeechAct } from '#choros/inbox.ts'
import { ERR_INVALID_PARAMS, type RpcError } from '#choros/protocol/methods.ts'
import { NOTIFY_INBOUND_MESSAGE } from '#choros/protocol/notifications.ts'

/** Helper: thread_id must follow the same shape rules as msg_id —
 *  no path separators, control chars, or other lexical traps. */
function requireThreadId(raw: string, label: string): string | RpcError {
  try {
    return sanitizeId(raw, `${label}.thread_id`)
  } catch (e: unknown) {
    return { code: ERR_INVALID_PARAMS, message: e instanceof Error ? e.message : String(e) }
  }
}

/** Most-recent N messages returned to a freshly-joining session. A
 *  thread with 10k+ messages would otherwise ship a multi-MB backlog
 *  frame on every join + a synchronous mcp.notification replay on
 *  the shim. Older history stays in the table; the client can
 *  paginate via a follow-up query if needed. */
const BACKLOG_LIMIT = 100

export interface JoinThreadResult {
  thread_id: string
  members: string[]
  backlog: BacklogEntry[]
}

export interface BacklogEntry {
  msg_id: string
  from_session: string
  body: string
  ts: string
  in_reply_to: string | null
}

function listMembers(ctx: HandlerCtx, threadId: string): string[] {
  return (
    ctx.storage.db
      .query('SELECT session_id FROM thread_members WHERE thread_id = ? ORDER BY session_id')
      .all(threadId) as { session_id: string }[]
  ).map(r => r.session_id)
}

function ensureThread(ctx: HandlerCtx, threadId: string): void {
  ctx.storage.db
    .query(
      `INSERT INTO threads (root_msg_id, created_at) VALUES (?, ?)
       ON CONFLICT(root_msg_id) DO NOTHING`,
    )
    .run(threadId, ctx.nowIso())
}

export function handleJoinThread(ctx: HandlerCtx, rawArgs: unknown): JoinThreadResult | RpcError {
  const obj = asObject(rawArgs, 'join_thread')
  if (isRpcError(obj)) return obj
  const session_id = requireString(obj, 'session_id', 'join_thread')
  if (isRpcError(session_id)) return session_id
  const thread_id_raw = requireString(obj, 'thread_id', 'join_thread')
  if (isRpcError(thread_id_raw)) return thread_id_raw
  const thread_id = requireThreadId(thread_id_raw, 'join_thread')
  if (isRpcError(thread_id)) return thread_id

  ensureThread(ctx, thread_id)
  ctx.storage.db
    .query(
      `INSERT INTO thread_members (thread_id, session_id, joined_at) VALUES (?, ?, ?)
       ON CONFLICT(thread_id, session_id) DO NOTHING`,
    )
    .run(thread_id, session_id, ctx.nowIso())

  // Thread messages are stored one row per recipient (mirrors v0's
  // per-recipient inbox). The backlog query collapses those back into
  // one row per logical message — without this dedupe, a joiner would
  // see N-1 copies of every prior message where N is the historical
  // member count when it was sent. Bounded to the most-recent
  // BACKLOG_LIMIT entries so an ancient thread doesn't ship megabytes
  // of history through every fresh joiner's first response.
  const backlog = (
    ctx.storage.db
      .query(
        `SELECT id, from_session, body, ts, in_reply_to FROM (
           SELECT MIN(id) AS id, from_session, body, ts, in_reply_to
           FROM messages
           WHERE thread_id = ?
           GROUP BY from_session, ts, body, COALESCE(in_reply_to, '')
           ORDER BY ts DESC
           LIMIT ?
         ) ORDER BY ts ASC`,
      )
      .all(thread_id, BACKLOG_LIMIT) as {
      id: string
      from_session: string
      body: string
      ts: string
      in_reply_to: string | null
    }[]
  ).map(r => ({
    msg_id: r.id,
    from_session: r.from_session,
    body: r.body,
    ts: r.ts,
    in_reply_to: r.in_reply_to,
  }))

  return { thread_id, members: listMembers(ctx, thread_id), backlog }
}

export interface LeaveThreadResult {
  thread_id: string
  members: string[]
}

export function handleLeaveThread(ctx: HandlerCtx, rawArgs: unknown): LeaveThreadResult | RpcError {
  const obj = asObject(rawArgs, 'leave_thread')
  if (isRpcError(obj)) return obj
  const session_id = requireString(obj, 'session_id', 'leave_thread')
  if (isRpcError(session_id)) return session_id
  const thread_id_raw = requireString(obj, 'thread_id', 'leave_thread')
  if (isRpcError(thread_id_raw)) return thread_id_raw
  const thread_id = requireThreadId(thread_id_raw, 'leave_thread')
  if (isRpcError(thread_id)) return thread_id

  ctx.storage.db
    .query('DELETE FROM thread_members WHERE thread_id = ? AND session_id = ?')
    .run(thread_id, session_id)
  return { thread_id, members: listMembers(ctx, thread_id) }
}

export interface ListThreadsResult {
  threads: {
    thread_id: string
    title: string | null
    member_count: number
    last_ts: string | null
  }[]
}

export function handleListThreads(ctx: HandlerCtx, rawArgs: unknown): ListThreadsResult | RpcError {
  const obj = asObject(rawArgs, 'list_threads')
  if (isRpcError(obj)) return obj
  const session_id = requireString(obj, 'session_id', 'list_threads')
  if (isRpcError(session_id)) return session_id

  // One scan per derived value via grouped LEFT JOINs, replacing the
  // two correlated subqueries (which run O(threads) extra queries
  // per call).
  const threads = ctx.storage.db
    .query(
      `SELECT t.root_msg_id AS thread_id,
              t.title,
              COALESCE(mc.member_count, 0) AS member_count,
              ml.last_ts
       FROM threads t
       JOIN thread_members me ON me.thread_id = t.root_msg_id AND me.session_id = ?
       LEFT JOIN (
         SELECT thread_id, COUNT(*) AS member_count
         FROM thread_members
         GROUP BY thread_id
       ) mc ON mc.thread_id = t.root_msg_id
       LEFT JOIN (
         SELECT thread_id, MAX(ts) AS last_ts
         FROM messages
         WHERE thread_id IS NOT NULL
         GROUP BY thread_id
       ) ml ON ml.thread_id = t.root_msg_id
       ORDER BY ml.last_ts DESC NULLS LAST`,
    )
    .all(session_id) as ListThreadsResult['threads']
  return { threads }
}

export interface SendToThreadResult {
  /** Null when the thread had no recipients (sender is the only
   *  member); nothing is persisted in that case so a follow-up
   *  react/mark_read against a fabricated id would fail. */
  msg_id: string | null
  thread_id: string
  delivered_to: string[]
}

export function handleSendToThread(
  ctx: HandlerCtx,
  rawArgs: unknown,
): SendToThreadResult | RpcError {
  const obj = asObject(rawArgs, 'send_to_thread')
  if (isRpcError(obj)) return obj
  const session_id = requireString(obj, 'session_id', 'send_to_thread')
  if (isRpcError(session_id)) return session_id
  const thread_id_raw = requireString(obj, 'thread_id', 'send_to_thread')
  if (isRpcError(thread_id_raw)) return thread_id_raw
  const thread_id = requireThreadId(thread_id_raw, 'send_to_thread')
  if (isRpcError(thread_id)) return thread_id
  const body = requireString(obj, 'body', 'send_to_thread')
  if (isRpcError(body)) return body
  try {
    enforceBodyCap(body, 'send_to_thread')
  } catch (e: unknown) {
    return { code: ERR_INVALID_PARAMS, message: e instanceof Error ? e.message : String(e) }
  }
  const actRaw = optionalString(obj, 'act', 'send_to_thread')
  if (isRpcError(actRaw)) return actRaw
  let act: string | undefined
  try {
    act = validateSpeechAct(actRaw)
  } catch (e: unknown) {
    return { code: ERR_INVALID_PARAMS, message: e instanceof Error ? e.message : String(e) }
  }
  const replyTo = optionalString(obj, 'in_reply_to', 'send_to_thread')
  if (isRpcError(replyTo)) return replyTo

  ensureThread(ctx, thread_id)
  // Sender auto-joins; mirrors v0 behavior.
  ctx.storage.db
    .query(
      `INSERT INTO thread_members (thread_id, session_id, joined_at) VALUES (?, ?, ?)
       ON CONFLICT(thread_id, session_id) DO NOTHING`,
    )
    .run(thread_id, session_id, ctx.nowIso())

  const recipients = (
    ctx.storage.db
      .query('SELECT session_id FROM thread_members WHERE thread_id = ? AND session_id != ?')
      .all(thread_id, session_id) as { session_id: string }[]
  ).map(r => r.session_id)

  if (recipients.length === 0) {
    return { msg_id: null, thread_id, delivered_to: [] }
  }

  const msgId = generateMessageId(session_id, ctx.nowIso())
  const senderName = cachedSenderName(ctx, session_id)

  const ts = ctx.nowIso()
  const replyTrim = replyTo?.trim() || null
  const perPeerIds = recipients.map(peer => ({ peer, perPeerId: `${msgId}-${peer}` }))

  ctx.storage.db.transaction(() => {
    const insert = ctx.storage.db.query(
      `INSERT INTO messages (id, from_session, to_session, thread_id, body, act, in_reply_to, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const { perPeerId, peer } of perPeerIds) {
      insert.run(perPeerId, session_id, peer, thread_id, body, act ?? null, replyTrim, ts)
    }
  })()

  // Fan-out happens AFTER commit so socket writes don't hold the WAL
  // writer lock and starve concurrent writers.
  for (const { perPeerId, peer } of perPeerIds) {
    deliverOrBuffer(ctx, peer, NOTIFY_INBOUND_MESSAGE, {
      msg_id: perPeerId,
      from_session: session_id,
      from_name: senderName,
      to_session: peer,
      thread_id,
      body,
      ts,
      ...(act ? { act } : {}),
      ...(replyTrim ? { in_reply_to: replyTrim } : {}),
    })
  }

  return { msg_id: msgId, thread_id, delivered_to: recipients }
}
