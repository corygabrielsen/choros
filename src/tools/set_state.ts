import type { Context } from '#choros/effects.ts'
import { applyIntent, applyStatus, readAgentState, writeAgentState } from '#choros/heartbeat.ts'
import { createKeyedMutex } from '#choros/mutex.ts'

/** Path to the per-session `.agent_state` file. */
export interface SetStateTargets {
  agentStatePath: string
}

// `.agent_state` is read-modify-write: `set_status` reads the current
// state, merges its field, and writes the result. A concurrent
// `set_intent` does the same; without serialization the second write
// overwrites the first's merge. Per-file mutex (keyed on the path)
// serializes the read+merge+write sequence.
const stateMutex = createKeyedMutex()

/**
 * Set this session's ambient status, visible to peers via `doctor`.
 *
 * @remarks
 * Empty `text` clears the status. Persisted to `.agent_state`; merged
 * into the next heartbeat tick. Serialized on the file path so
 * concurrent set_status / set_intent cannot lose updates.
 */
export function handleSetStatus(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc'>,
  targets: SetStateTargets,
  text: string,
): Promise<{ status: string | null }> {
  return stateMutex.run(targets.agentStatePath, async () => {
    const current = await readAgentState(ctx, targets.agentStatePath)
    const next = applyStatus(current, text, ctx.clock.nowIso())
    await writeAgentState(ctx, targets.agentStatePath, next)
    return { status: next.status ?? null }
  })
}

/**
 * Set this session's ambient intent (the bigger goal), visible to peers
 * via `doctor`.
 *
 * @remarks
 * Empty `text` clears the intent. Persisted to `.agent_state`.
 * Serialized on the file path.
 */
export function handleSetIntent(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc'>,
  targets: SetStateTargets,
  text: string,
): Promise<{ intent: string | null }> {
  return stateMutex.run(targets.agentStatePath, async () => {
    const current = await readAgentState(ctx, targets.agentStatePath)
    const next = applyIntent(current, text, ctx.clock.nowIso())
    await writeAgentState(ctx, targets.agentStatePath, next)
    return { intent: next.intent ?? null }
  })
}
