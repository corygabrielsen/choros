import type { AskRegistry } from '../ask-registry.ts'
import type { Context } from '../effects.ts'
import { generateMessageId, isSelf, resolveRecipient } from '../identity.ts'
import { asStringField, type InboxMessage } from '../inbox.ts'
import { handleSend, type SendTargets } from './send.ts'

/** Default timeout for {@link handleAsk} when no `timeout_ms` is given. */
export const DEFAULT_ASK_TIMEOUT_MS = 60_000

/** Inputs accepted by `mcp__choros__ask`. */
export interface AskArgs {
  to?: string
  body?: string
  timeout_ms?: number
}

/** Outcome of an {@link handleAsk} call. Either an answer arrived in
 *  time, or the timeout fired. The promise never throws on these. */
export type AskResult =
  | { status: 'answered'; reply_msg_id: string; reply_body: string; reply_from: string }
  | { status: 'timeout'; question_msg_id: string }

/**
 * Send a QUESTION and block until the peer replies (or timeout).
 *
 * @remarks
 * Wraps {@link handleSend} with `act: "QUESTION"`, registers a waiter
 * keyed by the question's msg_id BEFORE the send writes the inbox file
 * (otherwise a fast reply could land between send and register and be
 * lost). The waiter resolves when an inbound message arrives with
 * `in_reply_to` matching the question's msg_id. On timeout, resolves
 * to `{ status: 'timeout' }` rather than throwing.
 *
 * @throws When `to` or `body` is missing, when `timeout_ms` is
 *   non-positive or non-numeric, or when the resolved recipient is
 *   this session.
 *
 * @returns `{ status: 'answered', reply_msg_id, reply_body, reply_from }`
 *   on a matching reply, or `{ status: 'timeout', question_msg_id }`.
 */
export async function handleAsk(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc' | 'env'>,
  targets: SendTargets,
  registry: AskRegistry,
  args: AskArgs,
): Promise<AskResult> {
  const to = asStringField(args.to, 'ask.to').trim()
  const body = asStringField(args.body, 'ask.body')
  if (!to) throw new Error('ask: "to" is required')
  if (!body) throw new Error('ask: "body" is required')
  let timeoutMs = DEFAULT_ASK_TIMEOUT_MS
  if (args.timeout_ms !== undefined) {
    if (
      typeof args.timeout_ms !== 'number' ||
      !Number.isFinite(args.timeout_ms) ||
      args.timeout_ms <= 0
    ) {
      throw new Error('ask: "timeout_ms" must be a positive finite number')
    }
    timeoutMs = args.timeout_ms
  }

  // Early validation that should throw synchronously to the caller — these
  // are not "ask failed midway, treat as timeout" cases, they're "your
  // invocation was malformed." Mirrors handleSend's first checks so the
  // contract is preserved even though we bypass handleSend's own throws
  // by catching them below (for race-safety on the registry).
  const recipient = await resolveRecipient(ctx, targets.stateRoot, targets.projectsRoot, to)
  if (
    await isSelf(ctx, targets.stateRoot, targets.me, targets.myName, recipient.id, recipient.name)
  ) {
    throw new Error('ask: cannot send to self')
  }

  // Pre-generate the msg_id and register the waiter BEFORE the send fires
  // the inbox write. Otherwise a fast peer could reply between handleSend
  // returning and registry.register() running, and notifyIfWaiting() would
  // find no waiter — the reply would be lost.
  const isoNow = ctx.clock.nowIso()
  const msgId = generateMessageId(targets.me, isoNow)

  return new Promise<AskResult>(resolve => {
    let settled = false
    const settle = (result: AskResult): void => {
      if (settled) return
      settled = true
      registry.unregister(msgId)
      timerHandle.clear()
      resolve(result)
    }
    registry.register(msgId, (reply: InboxMessage) => {
      settle({
        status: 'answered',
        reply_msg_id: reply.id,
        reply_body: reply.body ?? '',
        reply_from: reply.from_name ?? reply.from_session ?? 'unknown',
      })
    })
    const timerHandle = ctx.clock.setTimeout(() => {
      settle({ status: 'timeout', question_msg_id: msgId })
    }, timeoutMs)
    // Fire the send AFTER registration. If the send itself rejects we
    // surface that synchronously by settling with timeout (the waiter
    // never fires for an un-sent question).
    handleSend(ctx, targets, { to, body, act: 'QUESTION', msg_id: msgId }).catch((e: unknown) => {
      const m = e instanceof Error ? e.message : String(e)
      ctx.proc.stderr(`[choros] ask: send failed: ${m}\n`)
      settle({ status: 'timeout', question_msg_id: msgId })
    })
  })
}
