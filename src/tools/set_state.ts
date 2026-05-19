import type { Context } from '../effects.ts'
import { applyIntent, applyStatus, readAgentState, writeAgentState } from '../heartbeat.ts'

export interface SetStateTargets {
  agentStatePath: string
}

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
