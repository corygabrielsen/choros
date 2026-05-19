import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { asObject, isRpcError, requireString } from '#choros/daemon/helpers.ts'
import { ERR_INVALID_PARAMS, type RpcError } from '#choros/protocol/methods.ts'

export interface SubscribeResult {
  subscribed: string[]
}

/** Topic cap — short enough to fit in channel meta without bloat, long
 *  enough for any reasonable namespacing (`team/foo/bar`). */
const TOPIC_MAX_BYTES = 256

function parseArgs(
  rawArgs: unknown,
  label: string,
): { session_id: string; topic: string } | RpcError {
  const obj = asObject(rawArgs, label)
  if (isRpcError(obj)) return obj
  const session_id = requireString(obj, 'session_id', label)
  if (isRpcError(session_id)) return session_id
  const topic = requireString(obj, 'topic', label, TOPIC_MAX_BYTES)
  if (isRpcError(topic)) return topic
  // Canonicalize: trim + lowercase. Topics are channel names, not user
  // strings — `subscribe('FOO')` and `publish('foo')` should reach
  // each other. Case-sensitivity here was a silent subscriber-miss.
  const t = topic.trim().toLowerCase()
  if (t.length === 0) {
    return { code: ERR_INVALID_PARAMS, message: `${label}: "topic" must be non-empty` }
  }
  return { session_id, topic: t }
}

function listForSession(ctx: HandlerCtx, sessionId: string): string[] {
  return (
    ctx.storage.db
      .query('SELECT topic FROM subscriptions WHERE session_id = ? ORDER BY topic')
      .all(sessionId) as { topic: string }[]
  ).map(r => r.topic)
}

export function handleSubscribe(ctx: HandlerCtx, rawArgs: unknown): SubscribeResult | RpcError {
  const parsed = parseArgs(rawArgs, 'subscribe')
  if (isRpcError(parsed)) return parsed
  ctx.storage.db
    .query(
      `INSERT INTO subscriptions (session_id, topic, created_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id, topic) DO NOTHING`,
    )
    .run(parsed.session_id, parsed.topic, ctx.nowIso())
  return { subscribed: listForSession(ctx, parsed.session_id) }
}

export function handleUnsubscribe(ctx: HandlerCtx, rawArgs: unknown): SubscribeResult | RpcError {
  const parsed = parseArgs(rawArgs, 'unsubscribe')
  if (isRpcError(parsed)) return parsed
  ctx.storage.db
    .query('DELETE FROM subscriptions WHERE session_id = ? AND topic = ?')
    .run(parsed.session_id, parsed.topic)
  return { subscribed: listForSession(ctx, parsed.session_id) }
}
