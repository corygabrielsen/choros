import { join } from 'node:path'
import { atomicWrite } from '../delivery.ts'
import type { Context } from '../effects.ts'
import { isSelf, listKnownInstances, parseMentions } from '../identity.ts'
import { asStringField, enforceBodyCap, validateSpeechAct } from '../inbox.ts'
import { listSubscribers } from './subscribe.ts'

export interface PublishArgs {
  topic?: string
  body?: string
  act?: string
}

export interface PublishTargets {
  stateRoot: string
  projectsRoot: string
  me: string
  myName: string
  mySentDir: string
}

export interface PublishResult {
  msg_id: string
  topic: string
  delivered_to: string[]
}

export async function handlePublish(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc' | 'env'>,
  targets: PublishTargets,
  args: PublishArgs,
): Promise<PublishResult> {
  const topic = asStringField(args.topic, 'publish.topic').trim()
  const body = asStringField(args.body, 'publish.body')
  if (!topic) throw new Error('publish: "topic" is required')
  if (!body) throw new Error('publish: "body" is required')
  enforceBodyCap(body, 'publish')
  const act = validateSpeechAct(args.act)

  const known = await listKnownInstances(ctx, targets.stateRoot, targets.projectsRoot)
  const subscribers: string[] = []
  for (const k of known) {
    // Three-layer self-exclusion (v0.17 invariant) — must not deliver a
    // publish to ourselves even if we subscribed to our own topic.
    if (await isSelf(ctx, targets.stateRoot, targets.me, targets.myName, k.id, k.name)) continue
    if (await listSubscribers(ctx, targets.stateRoot, k.id, topic)) subscribers.push(k.id)
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
  const id = `${ts}-${targets.me.slice(0, 8)}`
  const msgBase = {
    id,
    from_session: targets.me,
    from_name: targets.myName,
    from_cwd: ctx.proc.cwd(),
    from_host: ctx.env.hostname(),
    body,
    ts: isoNow,
    topic,
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(act ? { act } : {}),
  }
  await ctx.fs.mkdir(targets.mySentDir, { recursive: true })
  await ctx.fs.writeFile(join(targets.mySentDir, `${id}.json`), JSON.stringify(msgBase, null, 2))
  await Promise.all(
    subscribers.map(async subId => {
      const payload = JSON.stringify({ ...msgBase, to_session: subId }, null, 2)
      const inboxDir = join(targets.stateRoot, subId, 'inbox')
      await ctx.fs.mkdir(inboxDir, { recursive: true })
      await atomicWrite(ctx, join(inboxDir, `${id}.json`), payload)
    }),
  )
  return { msg_id: id, topic, delivered_to: subscribers }
}
