import { join } from 'node:path'
import { atomicWrite } from '../delivery.ts'
import type { Context } from '../effects.ts'
import { type RecipientHealth, recipientLastAgentTurnAgeMs, recipientLiveness } from '../health.ts'
import { isSelf, parseMentions, resolveRecipient, sanitizeId } from '../identity.ts'
import { asStringField, enforceBodyCap, validateSpeechAct } from '../inbox.ts'

/** Inputs accepted by `mcp__choros__send`. */
export interface SendArgs {
  to?: string
  body?: string
  in_reply_to?: string
  act?: string
  /**
   * Pre-generated msg_id. Used by {@link handleAsk} so the waiter can be
   * registered BEFORE the inbox file is written — otherwise a fast reply
   * could land between send and register and the waiter would miss it.
   */
  msg_id?: string
}

/** Paths + identity that {@link handleSend} needs. Bound at boot from
 *  the production {@link Context} or test fixture. */
export interface SendTargets {
  stateRoot: string
  projectsRoot: string
  me: string
  myName: string
  mySentDir: string
}

/** Send-tool response. */
export interface SendResult {
  msg_id: string
  recipient_id: string
  recipient_name: string | null
  verify_path: string
  live_status: RecipientHealth['status']
  live_age_ms?: number | undefined
  last_agent_turn_age_ms?: number | undefined
}

/**
 * Send a message to a peer.
 *
 * @remarks
 * Resolves `to` against display names, session UUIDs, and UUID prefixes;
 * ambiguity is broken by most-recently-active. Writes to the sender's
 * `sent/` archive and atomically to the recipient's `inbox/`. The result
 * includes a `verify_path` (where the `.seen` sidecar will land on
 * JSONL-confirmed delivery) and a `live_status` describing recipient
 * health at send time.
 *
 * @throws When `to` or `body` is missing, when `body` exceeds the body
 *   cap, when `act` is not in the {@link SPEECH_ACTS} taxonomy, or when
 *   the resolved recipient is this session itself.
 */
export async function handleSend(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc' | 'env'>,
  targets: SendTargets,
  args: SendArgs,
): Promise<SendResult> {
  const toArg = asStringField(args.to, 'send.to').trim()
  const body = asStringField(args.body, 'send.body')
  if (!toArg) throw new Error('send: "to" is required')
  if (!body) throw new Error('send: "body" is required')
  enforceBodyCap(body, 'send')
  const act = validateSpeechAct(args.act)

  const recipient = await resolveRecipient(ctx, targets.stateRoot, targets.projectsRoot, toArg)
  const identity = { me: targets.me, name: targets.myName }
  if (
    await isSelf(ctx, targets.stateRoot, identity.me, identity.name, recipient.id, recipient.name)
  ) {
    throw new Error('send: cannot send to self')
  }
  const mentions = await parseMentions(
    ctx,
    targets.stateRoot,
    targets.projectsRoot,
    targets.me,
    targets.myName,
    body,
  )
  const isoNow = ctx.clock.nowIso()
  const ts = isoNow.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  // Caller-supplied msg_id (handleAsk uses this so the waiter can be
  // registered before the inbox file is written). Sanitize aggressively
  // since it flows into both the sender's `sent/` filename AND the
  // recipient's `inbox/` filename via path join.
  const id = args.msg_id
    ? sanitizeId(args.msg_id, 'send.msg_id')
    : `${ts}-${targets.me.slice(0, 8)}`
  const msg: Record<string, unknown> = {
    id,
    from_session: targets.me,
    from_name: targets.myName,
    from_cwd: ctx.proc.cwd(),
    from_host: ctx.env.hostname(),
    to_session: recipient.id,
    to_name: recipient.name,
    body,
    ts: isoNow,
  }
  if (mentions.length > 0) msg.mentions = mentions
  if (act) msg.act = act
  if (typeof args.in_reply_to === 'string' && args.in_reply_to.trim()) {
    msg.in_reply_to = args.in_reply_to.trim()
  }
  const payload = JSON.stringify(msg, null, 2)
  await ctx.fs.mkdir(targets.mySentDir, { recursive: true })
  await ctx.fs.writeFile(join(targets.mySentDir, `${id}.json`), payload)

  const recipientInbox = join(targets.stateRoot, recipient.id, 'inbox')
  await ctx.fs.mkdir(recipientInbox, { recursive: true })
  const finalPath = join(recipientInbox, `${id}.json`)
  await atomicWrite(ctx, finalPath, payload)

  const turnAge = await recipientLastAgentTurnAgeMs(ctx, recipient.id, targets.projectsRoot)
  const live = await recipientLiveness(ctx, targets.stateRoot, recipient.id, turnAge)
  return {
    msg_id: id,
    recipient_id: recipient.id,
    recipient_name: recipient.name,
    verify_path: `${finalPath}.seen`,
    live_status: live.status,
    live_age_ms: live.age_ms,
    last_agent_turn_age_ms: live.last_agent_turn_age_ms,
  }
}
