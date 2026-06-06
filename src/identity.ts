import { join } from 'node:path'
import type { Context } from '#choros/effects.ts'

/** RFC 4122 UUID shape — used by the shim to recognise CC session
 *  identities and by the daemon's `resolveRecipient` to short-circuit
 *  the lookup path. Kept loose (any hex/version) so synthetic test
 *  fixtures + future UUID variants both fit; the nil UUID is rejected
 *  separately via {@link NIL_UUID} so it can't slip in as a
 *  synthetic-target sentinel. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The all-zero UUID. RFC 4122 reserves this as a "nil" sentinel; we
 *  reject it as a target because resolveRecipient's synthetic-target
 *  fallback would otherwise let a peer write messages addressed to
 *  the void. */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/** Monotonic per-process counter used by {@link generateMessageId}.
 *  Combined with millisecond-precision timestamps and an 8-char
 *  session prefix, makes intra-second collisions impossible. */
let messageIdCounter = 0

/** Build a filesystem-safe message id that is unique across the
 *  (session, ms, counter) triple. Format:
 *  `YYYYMMDDThhmmssfffZ-<base36-counter>-<8-char-session-prefix>`. */
export function generateMessageId(me: string, isoNow: string): string {
  messageIdCounter = (messageIdCounter + 1) & 0xffffffff
  const ts = isoNow.replace(/[-:]/g, '').replace(/\.(\d+)Z$/, '$1Z')
  return `${ts}-${messageIdCounter.toString(36)}-${me.slice(0, 8)}`
}

/** Validate an identifier that's about to become part of a filesystem
 *  path or a SQL row identifier. Rejects empties, oversized inputs,
 *  path separators, control chars, NUL, and dot-prefixed values. */
export function sanitizeId(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`${label}: empty or non-string identifier`)
  }
  if (input.length > 256) {
    throw new Error(`${label}: identifier exceeds 256 chars`)
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — rejecting NUL + control chars
  if (/[\x00-\x1f\x7f/\\]/.test(input)) {
    throw new Error(`${label}: contains path separator, control char, or NUL`)
  }
  if (input === '.' || input === '..' || input.startsWith('.')) {
    throw new Error(`${label}: must not start with '.'`)
  }
  return input
}

/** Resolved session identity used once at shim boot. */
export interface Identity {
  me: string
  meIsUuid: boolean
  source:
    | 'CHOROS_IDENTITY'
    | 'cc-session-file'
    | 'CLAUDE_CODE_SESSION_ID'
    | 'newest-jsonl-in-project-dir'
    | 'CLAUDE_PROJECT_DIR'
    | 'PWD'
    | 'cwd'
}

/**
 * Resolve this CC session's identity once at shim boot. The shim
 * forwards this id to the daemon's `choros.register` handshake.
 *
 * Lookup order:
 *  1. `CHOROS_IDENTITY` env var (explicit override)
 *  2. `CLAUDE_CODE_SESSION_ID` when UUID-shaped
 *  3. Newest UUID-shaped `.jsonl` in the project directory derived
 *     from `CLAUDE_PROJECT_DIR` / `PWD` / cwd
 *  4. `CLAUDE_PROJECT_DIR` encoded as identity (non-UUID legacy)
 *  5. `PWD` encoded as identity
 *  6. cwd encoded as identity (last resort)
 */
export async function resolveIdentity(
  ctx: Pick<Context, 'env' | 'proc' | 'fs'>,
  projectsRoot?: string,
): Promise<Identity> {
  const explicit = ctx.env.get('CHOROS_IDENTITY')?.trim()
  if (explicit) {
    sanitizeId(explicit, 'CHOROS_IDENTITY')
    return { me: explicit, meIsUuid: false, source: 'CHOROS_IDENTITY' }
  }
  const sid = ctx.env.get('CLAUDE_CODE_SESSION_ID')?.trim()
  if (sid && UUID_RE.test(sid)) {
    return { me: sid, meIsUuid: true, source: 'CLAUDE_CODE_SESSION_ID' }
  }
  if (projectsRoot) {
    const newest = await newestSessionJsonl(ctx, projectsRoot)
    if (newest) return { me: newest, meIsUuid: true, source: 'newest-jsonl-in-project-dir' }
  }
  const projectDir = ctx.env.get('CLAUDE_PROJECT_DIR')?.trim()
  if (projectDir) {
    const id = sanitizeId(encodedCwd(projectDir).replace(/^-+/, ''), 'CLAUDE_PROJECT_DIR')
    return { me: id, meIsUuid: false, source: 'CLAUDE_PROJECT_DIR' }
  }
  const pwd = ctx.env.get('PWD')?.trim()
  if (pwd) {
    const id = sanitizeId(encodedCwd(pwd).replace(/^-+/, ''), 'PWD')
    return { me: id, meIsUuid: false, source: 'PWD' }
  }
  const id = sanitizeId(encodedCwd(ctx.proc.cwd()).replace(/^-+/, ''), 'cwd')
  return { me: id, meIsUuid: false, source: 'cwd' }
}

/** Encode a filesystem path the way Claude Code names its per-project
 *  state directories: replace `/` with `-`. */
export function encodedCwd(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

async function newestSessionJsonl(
  ctx: Pick<Context, 'env' | 'proc' | 'fs'>,
  projectsRoot: string,
): Promise<string | null> {
  const pwd =
    ctx.env.get('CLAUDE_PROJECT_DIR')?.trim() || ctx.env.get('PWD')?.trim() || ctx.proc.cwd()
  const projectDir = join(projectsRoot, encodedCwd(pwd))
  let entries: string[]
  try {
    entries = await ctx.fs.readdir(projectDir)
  } catch {
    return null
  }
  const candidates: { id: string; mtime: number }[] = []
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    const id = name.slice(0, -'.jsonl'.length)
    if (!UUID_RE.test(id)) continue
    try {
      const s = await ctx.fs.stat(join(projectDir, name))
      candidates.push({ id, mtime: s.mtimeMs })
    } catch {
      /* skip unreadable */
    }
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0]?.id ?? null
}
