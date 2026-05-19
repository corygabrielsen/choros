import { join } from 'node:path'
import { atomicWrite } from '../delivery.ts'
import type { Context } from '../effects.ts'
import { isSelf, sanitizeId } from '../identity.ts'
import { asStringField } from '../inbox.ts'

export interface ReactArgs {
  msg_id?: string
  emoji?: string
  from_session?: string
}

export interface ReactTargets {
  stateRoot: string
  me: string
  myName: string
}

export async function handleReact(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc'>,
  targets: ReactTargets,
  args: ReactArgs,
): Promise<{ wrote_to: string }> {
  const msgId = asStringField(args.msg_id, 'react.msg_id').trim()
  const emoji = asStringField(args.emoji, 'react.emoji').trim()
  const senderSession = asStringField(args.from_session, 'react.from_session').trim()
  if (!msgId) throw new Error('react: "msg_id" is required')
  if (!emoji) throw new Error('react: "emoji" is required')
  if (!senderSession) throw new Error('react: "from_session" is required')
  sanitizeId(msgId, 'react.msg_id')
  sanitizeId(senderSession, 'react.from_session')
  if (await isSelf(ctx, targets.stateRoot, targets.me, targets.myName, senderSession, null)) {
    throw new Error('react: cannot react to a message from self')
  }
  const senderAcksDir = join(targets.stateRoot, senderSession, 'sent_acks')
  await ctx.fs.mkdir(senderAcksDir, { recursive: true })
  const path = join(senderAcksDir, `${msgId}.react`)
  const payload = JSON.stringify({
    msg_id: msgId,
    emoji,
    by_session: targets.me,
    by_name: targets.myName,
    reacted_at: ctx.clock.nowIso(),
  })
  await atomicWrite(ctx, path, payload)
  return { wrote_to: path }
}
