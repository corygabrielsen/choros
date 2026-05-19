import { join } from 'node:path'
import { atomicWrite } from '#choros/delivery.ts'
import { ensureDir } from '#choros/dir-cache.ts'
import type { Context } from '#choros/effects.ts'
import { generateMessageId, sanitizeId } from '#choros/identity.ts'
import {
  asStringField,
  enforceBodyCap,
  type InboxMessage,
  validateSpeechAct,
} from '#choros/inbox.ts'
import {
  addMember,
  appendToThread,
  ensureThread,
  listMembers,
  listThreadsFor,
  readThread,
  removeMember,
  type ThreadSummary,
} from '#choros/threads.ts'

/** Paths + identity needed by the thread tool handlers. */
export interface ThreadTargets {
  stateRoot: string
  me: string
  myName: string
  mySentDir: string
}

/**
 * Subscribe this session to a thread and return the message backlog.
 *
 * @remarks
 * The thread is identified by its root msg_id. Joining an unknown
 * thread creates an empty one with this session as the sole member —
 * later writers can join the same id and the conversation begins.
 *
 * @throws When `thread_id` is empty or fails sanitization.
 */
export async function handleJoinThread(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc'>,
  targets: ThreadTargets,
  threadId: string,
): Promise<{ thread_id: string; members: string[]; backlog: InboxMessage[] }> {
  const t = asStringField(threadId, 'thread_id').trim()
  if (!t) throw new Error('join_thread: "thread_id" is required')
  sanitizeId(t, 'join_thread.thread_id')
  const members = await addMember(ctx, { stateRoot: targets.stateRoot }, t, targets.me)
  const backlog = await readThread(ctx, { stateRoot: targets.stateRoot }, t)
  return { thread_id: t, members, backlog }
}

/**
 * Remove this session from a thread's member list.
 *
 * @remarks
 * Idempotent — removing a session that is not a member is a no-op.
 * Existing messages in the thread remain on disk; the thread is not
 * deleted.
 */
export async function handleLeaveThread(
  ctx: Pick<Context, 'fs' | 'proc'>,
  targets: ThreadTargets,
  threadId: string,
): Promise<{ thread_id: string; members: string[] }> {
  const t = asStringField(threadId, 'thread_id').trim()
  if (!t) throw new Error('leave_thread: "thread_id" is required')
  sanitizeId(t, 'leave_thread.thread_id')
  const members = await removeMember(ctx, { stateRoot: targets.stateRoot }, t, targets.me)
  return { thread_id: t, members }
}

/**
 * List threads this session is a member of, sorted by last activity
 * (most recent first). Each entry includes the root msg_id, optional
 * title, message count, and member count.
 */
export function handleListThreads(
  ctx: Pick<Context, 'fs'>,
  targets: Pick<ThreadTargets, 'stateRoot' | 'me'>,
): Promise<ThreadSummary[]> {
  return listThreadsFor(ctx, { stateRoot: targets.stateRoot }, targets.me)
}

/** Inputs accepted by `mcp__choros__send_to_thread`. */
export interface SendToThreadArgs {
  thread_id?: string
  body?: string
  in_reply_to?: string
  act?: string
}

/** Send a message to an existing thread. Writes the message into the
 *  thread's msgs/ dir AND fan-outs to every member's inbox so their
 *  channel events fire. */
export async function handleSendToThread(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc' | 'env'>,
  targets: ThreadTargets,
  args: SendToThreadArgs,
): Promise<{
  msg_id: string
  thread_id: string
  fanned_out_to: string[]
  failures: string[]
}> {
  const threadId = asStringField(args.thread_id, 'send_to_thread.thread_id').trim()
  const body = asStringField(args.body, 'send_to_thread.body')
  if (!threadId) throw new Error('send_to_thread: "thread_id" is required')
  if (!body) throw new Error('send_to_thread: "body" is required')
  sanitizeId(threadId, 'send_to_thread.thread_id')
  enforceBodyCap(body, 'send_to_thread')
  const act = validateSpeechAct(args.act)

  await ensureThread(ctx, { stateRoot: targets.stateRoot }, threadId)
  await addMember(ctx, { stateRoot: targets.stateRoot }, threadId, targets.me)

  const isoNow = ctx.clock.nowIso()
  const id = generateMessageId(targets.me, isoNow)
  const msg: InboxMessage = {
    id,
    from_session: targets.me,
    from_name: targets.myName,
    from_host: ctx.env.hostname(),
    from_cwd: ctx.proc.cwd(),
    body,
    ts: isoNow,
    thread_id: threadId,
    ...(act ? { act } : {}),
    ...(typeof args.in_reply_to === 'string' && args.in_reply_to.trim()
      ? { in_reply_to: args.in_reply_to.trim() }
      : {}),
  }

  await appendToThread(ctx, { stateRoot: targets.stateRoot }, threadId, msg)
  await ensureDir(ctx, targets.mySentDir)
  await ctx.fs.writeFile(join(targets.mySentDir, `${id}.json`), JSON.stringify(msg))

  const members = await listMembers(ctx, { stateRoot: targets.stateRoot }, threadId)
  const recipients: string[] = []
  const failures: string[] = []
  for (const peerId of members) {
    if (peerId === targets.me) continue
    try {
      sanitizeId(peerId, 'send_to_thread.member')
    } catch {
      continue
    }
    try {
      const inboxDir = join(targets.stateRoot, peerId, 'inbox')
      await ensureDir(ctx, inboxDir)
      await atomicWrite(
        ctx,
        join(inboxDir, `${id}.json`),
        JSON.stringify({ ...msg, to_session: peerId }),
      )
      recipients.push(peerId)
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e)
      ctx.proc.stderr(`[choros] send_to_thread fan-out to ${peerId.slice(0, 8)} failed: ${m}\n`)
      failures.push(peerId)
    }
  }
  return { msg_id: id, thread_id: threadId, fanned_out_to: recipients, failures }
}
