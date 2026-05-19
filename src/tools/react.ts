import { join } from 'node:path'
import { atomicWrite } from '#choros/delivery.ts'
import type { Context } from '#choros/effects.ts'
import { isSelf, sanitizeId } from '#choros/identity.ts'
import { asStringField } from '#choros/inbox.ts'

/** Inputs accepted by `mcp__choros__react`. */
export interface ReactArgs {
  msg_id?: string
  emoji?: string
  from_session?: string
}

/** Paths + identity that {@link handleReact} needs. */
export interface ReactTargets {
  stateRoot: string
  me: string
  myName: string
}

/**
 * React to a received message with an emoji.
 *
 * @remarks
 * Drops a `.react` file into the sender's `sent_acks/` dir; the sender's
 * bun (via its `sent_acks` inotify watcher) surfaces a
 * `choros-reaction` channel event to the original sender's agent.
 * Refuses reactions to one's own messages.
 *
 * @throws When any required field is missing, when `msg_id` or
 *   `from_session` fails sanitization, or when the sender resolves to
 *   this session.
 */
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
  // Filename keyed on (msg_id, reactor) so two peers reacting to the
  // same message — or the same peer reacting twice — don't clobber one
  // another's `.react` file. The sender's bun consumes all matching
  // entries on its inotify pass.
  const reactorTag = targets.me.slice(0, 8)
  const path = join(senderAcksDir, `${msgId}.${reactorTag}.react`)
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
