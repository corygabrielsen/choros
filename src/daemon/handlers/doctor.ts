import { DEAD_AGE_MS, LIVE_MAX_AGE_MS } from '#choros/constants.ts'
import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { asObject, isRpcError, nowMsFromCtx, requireString } from '#choros/daemon/helpers.ts'
import type { RpcError } from '#choros/protocol/methods.ts'

/** Max peers returned by doctor. Without this, agent_status /
 *  agent_intent — both 8 KB strings the operator may have set
 *  assuming session-internal scope — would be enumerable across the
 *  daemon's entire history. doctor's purpose is "what's near me right
 *  now," not a long-tail audit log. */
const DOCTOR_PEER_CAP = 64
/** Drop peers whose heartbeat is older than this from the doctor
 *  report. Past DEAD_AGE_MS the row carries no useful diagnostic
 *  signal — only stale ambient state. */
const DOCTOR_PEER_HEARTBEAT_CUTOFF_MS = DEAD_AGE_MS

export type Classification = 'live' | 'wedged' | 'stale' | 'dead' | 'none'

export interface DoctorPeer {
  session_id: string
  display_name: string | null
  classification: Classification
  heartbeat_age_ms: number | null
  wedged: boolean
  bun_alive: boolean
  agent_status: string | null
  agent_intent: string | null
}

export interface DoctorReport {
  self: {
    session_id: string
    display_name: string | null
    inbox_unread: number
  }
  peers: DoctorPeer[]
}

function classify(
  heartbeatAgeMs: number | null,
  bunAlive: boolean,
  wedged: boolean,
): Classification {
  if (heartbeatAgeMs === null) return 'none'
  if (heartbeatAgeMs > DEAD_AGE_MS) return 'dead'
  if (!bunAlive) return 'dead'
  if (heartbeatAgeMs > LIVE_MAX_AGE_MS) return 'stale'
  if (wedged) return 'wedged'
  return 'live'
}

export function handleDoctor(ctx: HandlerCtx, rawArgs: unknown): DoctorReport | RpcError {
  const obj = asObject(rawArgs, 'doctor')
  if (isRpcError(obj)) return obj
  const sessionId = requireString(obj, 'session_id', 'doctor')
  if (isRpcError(sessionId)) return sessionId

  const self = ctx.storage.db
    .query('SELECT id, display_name FROM sessions WHERE id = ?')
    .get(sessionId) as { id: string; display_name: string | null } | null

  const inboxUnread = (
    ctx.storage.db
      .query(
        `SELECT COUNT(*) AS n FROM messages
         WHERE to_session = ? AND delivered_at IS NULL AND read_at IS NULL`,
      )
      .get(sessionId) as { n: number }
  ).n

  const now = nowMsFromCtx(ctx)
  const recencyCutoff = new Date(now - DOCTOR_PEER_HEARTBEAT_CUTOFF_MS).toISOString()
  const peerRows = ctx.storage.db
    .query(
      `SELECT id, display_name, heartbeat_at, lock_pid, wedged_at, agent_status, agent_intent
       FROM sessions
       WHERE id != ? AND heartbeat_at IS NOT NULL AND heartbeat_at >= ?
       ORDER BY heartbeat_at DESC NULLS LAST
       LIMIT ?`,
    )
    .all(sessionId, recencyCutoff, DOCTOR_PEER_CAP) as {
    id: string
    display_name: string | null
    heartbeat_at: string | null
    lock_pid: number | null
    wedged_at: string | null
    agent_status: string | null
    agent_intent: string | null
  }[]

  const peers: DoctorPeer[] = peerRows.map(r => {
    const age = r.heartbeat_at === null ? null : now - Date.parse(r.heartbeat_at)
    const bunAlive = r.lock_pid !== null && age !== null && age <= LIVE_MAX_AGE_MS
    const wedged = r.wedged_at !== null
    return {
      session_id: r.id,
      display_name: r.display_name,
      classification: classify(age, bunAlive, wedged),
      heartbeat_age_ms: age,
      wedged,
      bun_alive: bunAlive,
      agent_status: r.agent_status,
      agent_intent: r.agent_intent,
    }
  })

  return {
    self: {
      session_id: sessionId,
      display_name: self?.display_name ?? null,
      inbox_unread: inboxUnread,
    },
    peers,
  }
}
