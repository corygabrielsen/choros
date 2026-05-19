import { join } from 'node:path'
import { atomicWrite } from '#choros/delivery.ts'
import type { Context } from '#choros/effects.ts'
import { generateMessageId, parseMentions } from '#choros/identity.ts'
import { asStringField, enforceBodyCap, validateSpeechAct } from '#choros/inbox.ts'
import { liveEligiblePeers } from '#choros/presence.ts'

/** Inputs accepted by `mcp__choros__broadcast`. */
export interface BroadcastArgs {
  body?: string
  act?: string
}

/** Paths + identity that {@link handleBroadcast} needs. */
export interface BroadcastTargets {
  stateRoot: string
  projectsRoot: string
  me: string
  myName: string
  mySentDir: string
}

/** Broadcast-tool response. */
export interface BroadcastResult {
  msg_id: string
  recipients: string[]
  failures: { recipient: string; error: string }[]
}

/**
 * Fan a single message out to every live peer.
 *
 * @remarks
 * Live-peer enumeration applies three-layer self-exclusion (UUID + name
 * + heartbeat pid) and the pid-alive check so a freshly-exited peer with
 * a still-fresh heartbeat is excluded. Per-peer inbox writes are
 * parallelized via {@link Promise.all}.
 *
 * @throws When `body` is empty or exceeds the body cap, or when `act`
 *   is not in the {@link SPEECH_ACTS} taxonomy.
 */
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
  const id = generateMessageId(targets.me, isoNow)
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
  const delivered: string[] = []
  const failures: { recipient: string; error: string }[] = []
  await Promise.all(
    recipients.map(async r => {
      try {
        const payload = JSON.stringify({ ...msgBase, to_session: r.id, to_name: r.name }, null, 2)
        const inboxDir = join(targets.stateRoot, r.id, 'inbox')
        await ctx.fs.mkdir(inboxDir, { recursive: true })
        await atomicWrite(ctx, join(inboxDir, `${id}.json`), payload)
        delivered.push(r.id)
      } catch (e: unknown) {
        failures.push({ recipient: r.id, error: e instanceof Error ? e.message : String(e) })
      }
    }),
  )
  return { msg_id: id, recipients: delivered, failures }
}
