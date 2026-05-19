import { join } from 'node:path'
import { atomicWrite } from '../delivery.ts'
import type { Context } from '../effects.ts'
import { sanitizeId } from '../identity.ts'
import { type InboxMessage, asStringField, enforceBodyCap, validateSpeechAct } from '../inbox.ts'
import {
  type ThreadSummary,
  addMember,
  appendToThread,
  ensureThread,
  listMembers,
  listThreadsFor,
  readThread,
  removeMember,
} from '../threads.ts'

export interface ThreadTargets {
  stateRoot: string
  me: string
  myName: string
  mySentDir: string
}

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

export async function handleListThreads(
  ctx: Pick<Context, 'fs'>,
  targets: Pick<ThreadTargets, 'stateRoot' | 'me'>,
): Promise<ThreadSummary[]> {
  return listThreadsFor(ctx, { stateRoot: targets.stateRoot }, targets.me)
}

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
  const ts = isoNow.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const id = `${ts}-${targets.me.slice(0, 8)}`
  const msg: InboxMessage = {
    id,
    from_session: targets.me,
    from_name: targets.myName,
    from_host: undefined,
    from_cwd: ctx.proc.cwd(),
    body,
    ts: isoNow,
    ...(act ? { act } : {}),
    ...(args.in_reply_to ? { in_reply_to: args.in_reply_to } : {}),
  }
  ;(msg as Record<string, unknown>).thread_id = threadId
  ;(msg as Record<string, unknown>).from_host = ctx.env.hostname()

  await appendToThread(ctx, { stateRoot: targets.stateRoot }, threadId, msg)
  await ctx.fs.mkdir(targets.mySentDir, { recursive: true })
  await ctx.fs.writeFile(join(targets.mySentDir, `${id}.json`), JSON.stringify(msg, null, 2))

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
      await ctx.fs.mkdir(inboxDir, { recursive: true })
      await atomicWrite(
        ctx,
        join(inboxDir, `${id}.json`),
        JSON.stringify({ ...msg, to_session: peerId }, null, 2),
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
