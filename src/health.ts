import { join } from 'node:path'
import type { Context } from './effects.ts'
import { findJsonlForSession } from './identity.ts'

export const LIVE_MAX_AGE_MS = 90_000
export const DEAD_AGE_MS = 600_000

/** Age of the recipient's CC JSONL last modification. Stale value =
 *  the agent hasn't taken a tool-loop turn recently. Distinct from
 *  heartbeat age: bun-alive + agent-paused has fresh heartbeat AND
 *  stale agent-turn. */
export async function recipientLastAgentTurnAgeMs(
  ctx: Pick<Context, 'fs' | 'clock' | 'env' | 'proc'>,
  recipientId: string,
  projectsRoot: string,
): Promise<number | undefined> {
  const jsonl = await findJsonlForSession(ctx, projectsRoot, recipientId)
  if (!jsonl) return undefined
  try {
    const s = await ctx.fs.stat(jsonl)
    return ctx.clock.nowMs() - s.mtimeMs
  } catch {
    return undefined
  }
}

export type Classification = 'live' | 'paused' | 'wedged' | 'stale' | 'dead' | 'none'

/** A peer is "live" only if its heartbeat mtime is fresh AND its bun
 *  process is actually running. The bun-alive check is what distinguishes
 *  a recently-exited peer (whose .heartbeat mtime is still fresh because
 *  the kernel does not invalidate mtime on the writer's death) from a
 *  peer whose bun is actually serving. */
export async function isLivePeer(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc'>,
  stateRoot: string,
  peerId: string,
): Promise<boolean> {
  try {
    const raw = await ctx.fs.readFile(join(stateRoot, peerId, '.heartbeat'))
    const s = await ctx.fs.stat(join(stateRoot, peerId, '.heartbeat'))
    if (ctx.clock.nowMs() - s.mtimeMs > LIVE_MAX_AGE_MS) return false
    let hb: unknown
    try {
      hb = JSON.parse(raw)
    } catch {
      return false
    }
    const pid = (hb as { pid?: unknown })?.pid
    if (typeof pid !== 'number') return false
    return await ctx.proc.pidAlive(pid)
  } catch {
    return false
  }
}

/** Classify a peer for doctor output. The `dead` class now also covers
 *  the fresh-mtime + dead-pid case — pre-v0.17 that combination falsely
 *  rendered as `live`. */
export function classifyPeerHeartbeat(
  heartbeatAgeMs: number | undefined,
  hasWedge: boolean,
  agentTurnAgeMs: number | undefined,
  bunAlive: boolean,
): Classification {
  if (heartbeatAgeMs === undefined) return 'none'
  if (heartbeatAgeMs > DEAD_AGE_MS) return 'dead'
  if (!bunAlive) return 'dead'
  if (heartbeatAgeMs > LIVE_MAX_AGE_MS) return 'stale'
  if (hasWedge) return 'wedged'
  if (agentTurnAgeMs !== undefined && agentTurnAgeMs > LIVE_MAX_AGE_MS) return 'paused'
  return 'live'
}

export interface RecipientHealth {
  status: 'live' | 'stale' | 'wedged' | 'unknown'
  age_ms?: number
  last_agent_turn_age_ms?: number
  wedge_detected_at?: string
  wedge_pending_msg_ids?: string[]
}

/** Probe a recipient's health for inclusion in send-tool response. Returns
 *  `unknown` if there is no heartbeat file; `stale` when the heartbeat is
 *  fresh but the bun process is gone (the v0.17 invariant); `wedged` when
 *  fresh+alive but `.wedged` marker present; `live` otherwise. */
export async function recipientLiveness(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc'>,
  stateRoot: string,
  recipientId: string,
  lastAgentTurnAgeMs: number | undefined,
): Promise<RecipientHealth> {
  let heartbeatAgeMs: number | undefined
  let peerPid: number | undefined
  try {
    const s = await ctx.fs.stat(join(stateRoot, recipientId, '.heartbeat'))
    heartbeatAgeMs = ctx.clock.nowMs() - s.mtimeMs
    try {
      const hb = JSON.parse(await ctx.fs.readFile(join(stateRoot, recipientId, '.heartbeat')))
      if (typeof hb?.pid === 'number') peerPid = hb.pid
    } catch {
      /* malformed heartbeat */
    }
  } catch {
    return { status: 'unknown' }
  }

  const bunAlive = peerPid !== undefined && (await ctx.proc.pidAlive(peerPid))
  if (heartbeatAgeMs <= LIVE_MAX_AGE_MS && !bunAlive) {
    return { status: 'stale', age_ms: heartbeatAgeMs, last_agent_turn_age_ms: lastAgentTurnAgeMs }
  }
  if (heartbeatAgeMs <= LIVE_MAX_AGE_MS) {
    try {
      const wedgeRaw = await ctx.fs.readFile(join(stateRoot, recipientId, '.wedged'))
      const wedge = JSON.parse(wedgeRaw) as { detected_at?: string; pending_msg_ids?: string[] }
      return {
        status: 'wedged',
        age_ms: heartbeatAgeMs,
        last_agent_turn_age_ms: lastAgentTurnAgeMs,
        wedge_detected_at: wedge.detected_at,
        wedge_pending_msg_ids: wedge.pending_msg_ids,
      }
    } catch {
      /* not wedged */
    }
    return { status: 'live', age_ms: heartbeatAgeMs, last_agent_turn_age_ms: lastAgentTurnAgeMs }
  }
  return { status: 'stale', age_ms: heartbeatAgeMs, last_agent_turn_age_ms: lastAgentTurnAgeMs }
}
