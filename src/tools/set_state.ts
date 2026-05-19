import type { Context } from '../effects.ts'
import { applyIntent, applyStatus, readAgentState, writeAgentState } from '../heartbeat.ts'

/** Path to the per-session `.agent_state` file. */
export interface SetStateTargets {
  agentStatePath: string
}

/**
 * Set this session's ambient status, visible to peers via `doctor`.
 *
 * @remarks
 * Empty `text` clears the status. Persisted to `.agent_state`; merged
 * into the next heartbeat tick.
 */
export async function handleSetStatus(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc'>,
  targets: SetStateTargets,
  text: string,
): Promise<{ status: string | null }> {
  const current = await readAgentState(ctx, targets.agentStatePath)
  const next = applyStatus(current, text, ctx.clock.nowIso())
  await writeAgentState(ctx, targets.agentStatePath, next)
  return { status: next.status ?? null }
}

/**
 * Set this session's ambient intent (the bigger goal), visible to peers
 * via `doctor`.
 *
 * @remarks
 * Empty `text` clears the intent. Persisted to `.agent_state`.
 */
export async function handleSetIntent(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc'>,
  targets: SetStateTargets,
  text: string,
): Promise<{ intent: string | null }> {
  const current = await readAgentState(ctx, targets.agentStatePath)
  const next = applyIntent(current, text, ctx.clock.nowIso())
  await writeAgentState(ctx, targets.agentStatePath, next)
  return { intent: next.intent ?? null }
}
