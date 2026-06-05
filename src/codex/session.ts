import { createHash } from 'node:crypto'
import { sanitizeId } from '#choros/identity.ts'

export interface CodexSessionIdentity {
  threadId: string
  sessionId: string
  displayName: string
}

/** Deterministic UUID-shaped Choros id for a Codex thread.
 *  Choros can route directly to UUID-shaped ids, so we hash Codex's
 *  opaque thread id into a stable custom UUID instead of storing
 *  `codex:<thread>` as a non-routable session id. */
export function codexSessionId(threadId: string): string {
  const clean = sanitizeId(threadId.trim(), 'CODEX_THREAD_ID')
  const bytes = createHash('sha256').update(`choros-codex:${clean}`).digest()
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20, 32)}`
}

export function defaultCodexDisplayName(threadId: string): string {
  const clean = sanitizeId(threadId.trim(), 'CODEX_THREAD_ID')
  const compact = clean.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12)
  return `codex-${compact || codexSessionId(clean).slice(0, 8)}`
}

export function resolveCodexIdentity(opts?: {
  threadId?: string | undefined
  sessionId?: string | undefined
  displayName?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
}): CodexSessionIdentity {
  const env = opts?.env ?? process.env
  const threadId =
    opts?.threadId?.trim() ||
    env.CHOROS_CODEX_THREAD_ID?.trim() ||
    env.CODEX_THREAD_ID?.trim() ||
    ''
  if (!threadId) {
    throw new Error('CODEX_THREAD_ID is required unless a thread id argument is provided')
  }
  const explicitSessionId = opts?.sessionId?.trim() || env.CHOROS_IDENTITY?.trim() || ''
  const sessionId = explicitSessionId
    ? sanitizeId(explicitSessionId, 'CHOROS_IDENTITY')
    : codexSessionId(threadId)
  const displayName =
    opts?.displayName?.trim() ||
    env.CHOROS_DISPLAY_NAME?.trim() ||
    defaultCodexDisplayName(threadId)
  return { threadId: sanitizeId(threadId, 'CODEX_THREAD_ID'), sessionId, displayName }
}
