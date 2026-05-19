import { join } from 'node:path'
import { atomicWrite } from '../delivery.ts'
import type { Context } from '../effects.ts'
import { parseMentions } from '../identity.ts'
import { asStringField, enforceBodyCap, validateSpeechAct } from '../inbox.ts'
import { liveEligiblePeers } from '../presence.ts'

export interface BroadcastArgs {
  body?: string
  act?: string
}

export interface BroadcastTargets {
  stateRoot: string
  projectsRoot: string
  me: string
  myName: string
  mySentDir: string
}

export interface BroadcastResult {
  msg_id: string
  recipients: string[]
}

export async function handleBroadcast(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc' | 'env'>,
  targets: BroadcastTargets,
  args: BroadcastArgs,
): Promise<BroadcastResult> {
  const body = asStringField(args.body, 'broadcast.body')
  if (!body) throw new Error('broadcast: "body" is required')
  enforceBodyCap(body, 'broadcast')
  const act = validateSpeechAct(args.act)

  const recipients = await liveEligiblePeers(ctx, {
    stateRoot: targets.stateRoot,
    projectsRoot: targets.projectsRoot,
    me: targets.me,
    myName: targets.myName,
  })
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
    broadcast: true,
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(act ? { act } : {}),
  }
  await ctx.fs.mkdir(targets.mySentDir, { recursive: true })
  await ctx.fs.writeFile(join(targets.mySentDir, `${id}.json`), JSON.stringify(msgBase, null, 2))
  await Promise.all(
    recipients.map(async r => {
      const payload = JSON.stringify({ ...msgBase, to_session: r.id, to_name: r.name }, null, 2)
      const inboxDir = join(targets.stateRoot, r.id, 'inbox')
      await ctx.fs.mkdir(inboxDir, { recursive: true })
      await atomicWrite(ctx, join(inboxDir, `${id}.json`), payload)
    }),
  )
  return { msg_id: id, recipients: recipients.map(r => r.id) }
}
