import type { AskRegistry } from '../ask-registry.ts'
import type { Context } from '../effects.ts'
import type { InboxMessage } from '../inbox.ts'
import { type SendTargets, handleSend } from './send.ts'

export const DEFAULT_ASK_TIMEOUT_MS = 60_000

export interface AskArgs {
  to?: string
  body?: string
  timeout_ms?: number
}

export type AskResult =
  | { status: 'answered'; reply_msg_id: string; reply_body: string; reply_from: string }
  | { status: 'timeout'; question_msg_id: string }

/** Synchronous ask. Sends a question with act:"QUESTION" and blocks
 *  awaiting an inbound message with in_reply_to:<that msg_id>. Times out
 *  after timeout_ms (default 60s) honestly — caller learns no answer
 *  arrived rather than blocking indefinitely. */
export async function handleAsk(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc' | 'env'>,
  targets: SendTargets,
  registry: AskRegistry,
  args: AskArgs,
): Promise<AskResult> {
  const to = (args.to ?? '').trim()
  const body = args.body ?? ''
  if (!to) throw new Error('ask: "to" is required')
  if (!body) throw new Error('ask: "body" is required')
  const timeoutMs =
    args.timeout_ms === undefined ? DEFAULT_ASK_TIMEOUT_MS : Math.max(1, args.timeout_ms)

  const sent = await handleSend(ctx, targets, { to, body, act: 'QUESTION' })

  return new Promise<AskResult>(resolve => {
    let settled = false
    const timerHandle = ctx.clock.setTimeout(() => {
      settle({ status: 'timeout', question_msg_id: sent.msg_id })
    }, timeoutMs)
    const settle = (result: AskResult): void => {
      if (settled) return
      settled = true
      registry.unregister(sent.msg_id)
      timerHandle.clear()
      resolve(result)
    }
    registry.register(sent.msg_id, (reply: InboxMessage) => {
      settle({
        status: 'answered',
        reply_msg_id: reply.id,
        reply_body: reply.body ?? '',
        reply_from: reply.from_name ?? reply.from_session ?? 'unknown',
      })
    })
  })
}
