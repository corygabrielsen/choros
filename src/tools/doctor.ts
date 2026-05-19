import { join } from 'node:path'
import type { Context } from '#choros/effects.ts'
import {
  type Classification,
  classifyPeerHeartbeat,
  recipientLastAgentTurnAgeMs,
} from '#choros/health.ts'
import { listKnownInstances } from '#choros/identity.ts'

/** Paths + identity that {@link handleDoctor} needs. */
export interface DoctorTargets {
  stateRoot: string
  projectsRoot: string
  me: string
  myName: string
  inboxDir: string
}

/** One peer's row in a doctor report. */
export interface DoctorPeer {
  session_id: string
  display_name: string | null
  classification: Classification
  heartbeat_age_ms?: number | undefined
  last_agent_turn_age_ms?: number | undefined
  wedged: boolean
  bun_alive: boolean
}

/** Top-level doctor response shape. */
export interface DoctorReport {
  self: {
    session_id: string
    display_name: string
    inbox_unread: number
  }
  peers: DoctorPeer[]
}

async function countUnreadInbox(ctx: Pick<Context, 'fs'>, inboxDir: string): Promise<number> {
  try {
    const entries = await ctx.fs.readdir(inboxDir)
    return entries.filter(e => e.endsWith('.json') && !e.endsWith('.seen')).length
  } catch {
    return 0
  }
}

/**
 * Diagnostic snapshot of this session and every known peer.
 *
 * @remarks
 * For each peer: heartbeat age, last-agent-turn age, wedge state,
 * bun-pid-alive, and classification (`live` / `paused` / `wedged` /
 * `stale` / `dead` / `none`). Self is excluded from the `peers` list.
 * Per-peer probes are parallelized.
 */
export async function handleDoctor(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc' | 'env'>,
  targets: DoctorTargets,
): Promise<DoctorReport> {
  const known = await listKnownInstances(ctx, targets.stateRoot, targets.projectsRoot)
  // Probe peers in parallel; each peer's I/O (stat, readFile, pidAlive,
  // JSONL lookup) is independent of every other's.
  const probes = await Promise.all(
    known
      .filter(k => k.id !== targets.me)
      .map(async k => {
        const dir = join(targets.stateRoot, k.id)
        let heartbeatAgeMs: number | undefined
        let peerPid: number | undefined
        try {
          const s = await ctx.fs.stat(join(dir, '.heartbeat'))
          heartbeatAgeMs = ctx.clock.nowMs() - s.mtimeMs
          const raw = await ctx.fs.readFile(join(dir, '.heartbeat'))
          const hb = JSON.parse(raw) as { pid?: number }
          if (typeof hb?.pid === 'number') peerPid = hb.pid
        } catch {
          /* no heartbeat or unparseable */
        }
        const bunAlive = peerPid !== undefined && (await ctx.proc.pidAlive(peerPid))
        const wedged = ctx.fs.existsSync(join(dir, '.wedged'))
        const lastAgent = await recipientLastAgentTurnAgeMs(ctx, k.id, targets.projectsRoot)
        const classification = classifyPeerHeartbeat(heartbeatAgeMs, wedged, lastAgent, bunAlive)
        return {
          session_id: k.id,
          display_name: k.name,
          classification,
          heartbeat_age_ms: heartbeatAgeMs,
          last_agent_turn_age_ms: lastAgent,
          wedged,
          bun_alive: bunAlive,
        } satisfies DoctorPeer
      }),
  )
  return {
    self: {
      session_id: targets.me,
      display_name: targets.myName,
      inbox_unread: await countUnreadInbox(ctx, targets.inboxDir),
    },
    peers: probes,
  }
}
