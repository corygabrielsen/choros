import { join } from 'node:path'
import { atomicWrite } from './delivery.ts'
import type { Context } from './effects.ts'
import type { InboxMessage } from './inbox.ts'

/** Per-thread on-disk layout (shared, not per-session):
 *
 *  $STATE_ROOT/.threads/<root_msg_id>/
 *    msgs/<msg_id>.json     # one file per message (atomic writes)
 *    members.json           # array of subscribed peer ids
 *    meta.json              # root_msg_id, created_at, title?
 *
 *  A thread's identity is its root msg_id — the id of the message that
 *  was first sent without an `in_reply_to`. Replies (`in_reply_to: <id>`)
 *  walk back to the root.
 */
export interface ThreadMeta {
  root_msg_id: string
  created_at: string
  title?: string
}

export interface ThreadTargets {
  stateRoot: string
}

function threadDir(stateRoot: string, rootId: string): string {
  return join(stateRoot, '.threads', rootId)
}

function msgsDir(stateRoot: string, rootId: string): string {
  return join(threadDir(stateRoot, rootId), 'msgs')
}

function membersPath(stateRoot: string, rootId: string): string {
  return join(threadDir(stateRoot, rootId), 'members.json')
}

function metaPath(stateRoot: string, rootId: string): string {
  return join(threadDir(stateRoot, rootId), 'meta.json')
}

/** Ensure the thread dir exists. Idempotent — first writer creates meta;
 *  subsequent calls leave it. */
export async function ensureThread(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc'>,
  targets: ThreadTargets,
  rootId: string,
  title?: string,
): Promise<void> {
  await ctx.fs.mkdir(msgsDir(targets.stateRoot, rootId), { recursive: true })
  if (!ctx.fs.existsSync(metaPath(targets.stateRoot, rootId))) {
    const meta: ThreadMeta = {
      root_msg_id: rootId,
      created_at: ctx.clock.nowIso(),
      ...(title ? { title } : {}),
    }
    await atomicWrite(ctx, metaPath(targets.stateRoot, rootId), JSON.stringify(meta))
  }
  if (!ctx.fs.existsSync(membersPath(targets.stateRoot, rootId))) {
    await atomicWrite(ctx, membersPath(targets.stateRoot, rootId), JSON.stringify([]))
  }
}

/** Append a message to a thread. The msg is written atomically as a
 *  per-file entry; thread membership and per-recipient inbox fan-out
 *  happen separately. */
export async function appendToThread(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc'>,
  targets: ThreadTargets,
  rootId: string,
  msg: InboxMessage,
): Promise<void> {
  await ensureThread(ctx, targets, rootId)
  const path = join(msgsDir(targets.stateRoot, rootId), `${msg.id}.json`)
  await atomicWrite(ctx, path, JSON.stringify(msg))
}

/** Read all messages in a thread, sorted by ts (best-effort: falls back
 *  to msg_id lex order when ts is missing). */
export async function readThread(
  ctx: Pick<Context, 'fs'>,
  targets: ThreadTargets,
  rootId: string,
): Promise<InboxMessage[]> {
  const dir = msgsDir(targets.stateRoot, rootId)
  let entries: string[]
  try {
    entries = await ctx.fs.readdir(dir)
  } catch {
    return []
  }
  const msgs: InboxMessage[] = []
  for (const e of entries) {
    if (!e.endsWith('.json')) continue
    try {
      msgs.push(JSON.parse(await ctx.fs.readFile(join(dir, e))) as InboxMessage)
    } catch {
      /* skip unparseable */
    }
  }
  msgs.sort((a, b) => {
    if (a.ts && b.ts) return a.ts.localeCompare(b.ts)
    return a.id.localeCompare(b.id)
  })
  return msgs
}

async function readMembers(
  ctx: Pick<Context, 'fs'>,
  targets: ThreadTargets,
  rootId: string,
): Promise<Set<string>> {
  try {
    const raw = await ctx.fs.readFile(membersPath(targets.stateRoot, rootId))
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((x): x is string => typeof x === 'string'))
  } catch {
    return new Set()
  }
}

async function writeMembers(
  ctx: Pick<Context, 'fs' | 'proc'>,
  targets: ThreadTargets,
  rootId: string,
  members: Set<string>,
): Promise<void> {
  await atomicWrite(
    ctx,
    membersPath(targets.stateRoot, rootId),
    JSON.stringify([...members].sort()),
  )
}

export async function listMembers(
  ctx: Pick<Context, 'fs'>,
  targets: ThreadTargets,
  rootId: string,
): Promise<string[]> {
  const set = await readMembers(ctx, targets, rootId)
  return [...set].sort()
}

export async function addMember(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc'>,
  targets: ThreadTargets,
  rootId: string,
  peerId: string,
): Promise<string[]> {
  await ensureThread(ctx, targets, rootId)
  const set = await readMembers(ctx, targets, rootId)
  set.add(peerId)
  await writeMembers(ctx, targets, rootId, set)
  return [...set].sort()
}

export async function removeMember(
  ctx: Pick<Context, 'fs' | 'proc'>,
  targets: ThreadTargets,
  rootId: string,
  peerId: string,
): Promise<string[]> {
  const set = await readMembers(ctx, targets, rootId)
  set.delete(peerId)
  await writeMembers(ctx, targets, rootId, set)
  return [...set].sort()
}

export interface ThreadSummary {
  root_msg_id: string
  title?: string
  created_at?: string
  message_count: number
  member_count: number
  last_ts?: string
}

export async function listThreadsFor(
  ctx: Pick<Context, 'fs'>,
  targets: ThreadTargets,
  peerId: string,
): Promise<ThreadSummary[]> {
  const root = join(targets.stateRoot, '.threads')
  let entries: string[]
  try {
    entries = await ctx.fs.readdir(root)
  } catch {
    return []
  }
  const out: ThreadSummary[] = []
  for (const rootId of entries) {
    const members = await readMembers(ctx, targets, rootId)
    if (!members.has(peerId)) continue
    const msgs = await readThread(ctx, targets, rootId)
    let meta: ThreadMeta | null = null
    try {
      meta = JSON.parse(await ctx.fs.readFile(metaPath(targets.stateRoot, rootId))) as ThreadMeta
    } catch {
      /* meta missing */
    }
    out.push({
      root_msg_id: rootId,
      title: meta?.title,
      created_at: meta?.created_at,
      message_count: msgs.length,
      member_count: members.size,
      last_ts: msgs.at(-1)?.ts,
    })
  }
  out.sort((a, b) => (b.last_ts ?? '').localeCompare(a.last_ts ?? ''))
  return out
}
