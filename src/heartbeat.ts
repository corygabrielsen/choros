import { atomicWrite } from './delivery.ts'
import type { Context } from './effects.ts'

export const HEARTBEAT_INTERVAL_MS = 30_000

export interface AgentState {
  status?: string
  status_set_at?: string
  intent?: string
  intent_set_at?: string
}

export interface HeartbeatPayload {
  pid: number
  ts: string
  cwd: string
  status?: string
  status_set_at?: string
  intent?: string
  intent_set_at?: string
  last_user_prompt?: string
}

export function buildHeartbeat(
  ctx: Pick<Context, 'clock' | 'proc'>,
  agentState: AgentState,
  lastUserPrompt?: string,
): HeartbeatPayload {
  const out: HeartbeatPayload = {
    pid: ctx.proc.pid(),
    ts: ctx.clock.nowIso(),
    cwd: ctx.proc.cwd(),
  }
  if (agentState.status) out.status = agentState.status
  if (agentState.status_set_at) out.status_set_at = agentState.status_set_at
  if (agentState.intent) out.intent = agentState.intent
  if (agentState.intent_set_at) out.intent_set_at = agentState.intent_set_at
  if (lastUserPrompt) out.last_user_prompt = lastUserPrompt
  return out
}

/** Write the heartbeat atomically. Peers stat this file every send/doctor
 *  call, so a half-written payload would break their parse. */
export async function writeHeartbeat(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc'>,
  path: string,
  payload: HeartbeatPayload,
): Promise<void> {
  await atomicWrite(ctx, path, JSON.stringify(payload))
}

/** Persist agent-set status/intent so the next bun restart inherits it.
 *  Atomic so a concurrent heartbeat tick reading this file never sees a
 *  truncated payload. */
export async function writeAgentState(
  ctx: Pick<Context, 'fs' | 'clock' | 'proc'>,
  path: string,
  state: AgentState,
): Promise<void> {
  await atomicWrite(ctx, path, JSON.stringify(state))
}

export async function readAgentState(ctx: Pick<Context, 'fs'>, path: string): Promise<AgentState> {
  try {
    const raw = await ctx.fs.readFile(path)
    const parsed = JSON.parse(raw) as AgentState
    return parsed
  } catch {
    return {}
  }
}

export function applyStatus(state: AgentState, text: string, nowIso: string): AgentState {
  if (text.length === 0) {
    const { status: _s, status_set_at: _at, ...rest } = state
    void _s
    void _at
    return rest
  }
  return { ...state, status: text, status_set_at: nowIso }
}

export function applyIntent(state: AgentState, text: string, nowIso: string): AgentState {
  if (text.length === 0) {
    const { intent: _i, intent_set_at: _at, ...rest } = state
    void _i
    void _at
    return rest
  }
  return { ...state, intent: text, intent_set_at: nowIso }
}
