import { join } from 'node:path'
import { LIVE_MAX_AGE_MS } from './constants.ts'
import type { Context } from './effects.ts'

/** RFC 4122 UUID shape — used to distinguish CC session identities
 *  from legacy cwd-encoded identifiers. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Validate an identifier that's about to become part of a filesystem path.
 *  Used at every boundary where untrusted input (msg_id, recipient handle,
 *  env override, body-derived from_session) flows into join(stateRoot, …). */
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

/** Resolved session identity. See {@link resolveIdentity} for the
 *  lookup order. */
export interface Identity {
  /** This session's id used as the FS dirname (UUID or override). */
  me: string
  /** True iff `me` is a UUID-shaped string. */
  meIsUuid: boolean
  /** How `me` was determined. */
  source:
    | 'CHOROS_IDENTITY'
    | 'CLAUDE_CODE_SESSION_ID'
    | 'newest-jsonl-in-project-dir'
    | 'CLAUDE_PROJECT_DIR'
    | 'PWD'
    | 'cwd'
}

/**
 * Resolve this session's identity from environment, project dir, and cwd.
 *
 * @remarks
 * Lookup order:
 *  1. `CHOROS_IDENTITY` — explicit override
 *  2. `CLAUDE_CODE_SESSION_ID` — when UUID-shaped
 *  3. Newest UUID-shaped `.jsonl` in the project directory derived from
 *     `CLAUDE_PROJECT_DIR` / `PWD` / cwd. Claude Code does not propagate
 *     `CLAUDE_CODE_SESSION_ID` to MCP subprocesses, so the newest JSONL
 *     in our project dir is almost certainly our own session — CC writes
 *     session metadata there within milliseconds of MCP spawn.
 *  4. `CLAUDE_PROJECT_DIR` — encoded as identity (legacy, non-UUID)
 *  5. `PWD` — encoded as identity (legacy)
 *  6. cwd — encoded as identity (last-resort)
 *
 * The `source` field on the returned identity records which step won, so
 * boot logs and doctor reports can attribute identity provenance.
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

/**
 * Locate the newest UUID-shaped `.jsonl` in the project directory that
 * encodes our current cwd. CC writes a session JSONL there on startup;
 * the newest one is almost certainly ours (within milliseconds of MCP
 * spawn) when `CLAUDE_CODE_SESSION_ID` isn't propagated.
 *
 * @returns The matching session UUID, or `null` if no eligible JSONL exists.
 */
export async function newestSessionJsonl(
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
  const candidates: Array<{ id: string; mtime: number }> = []
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

/** Encode a filesystem path the way Claude Code names its per-project
 *  state directories: replace `/` with `-`. The transform is the inverse
 *  of CC's encoding so we can locate the project dir from a cwd. */
export function encodedCwd(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

/** Locate the CC JSONL transcript for a session UUID. Tries the fast path
 *  (the projects dir derived from current cwd) then falls back to a full
 *  scan of the projects root. */
export async function findJsonlForSession(
  ctx: Pick<Context, 'fs' | 'env' | 'proc'>,
  projectsRoot: string,
  sessionId: string,
): Promise<string | null> {
  const pwd = ctx.env.get('PWD')?.trim() || ctx.proc.cwd()
  const fast = join(projectsRoot, encodedCwd(pwd), `${sessionId}.jsonl`)
  if (ctx.fs.existsSync(fast)) return fast
  try {
    const projects = await ctx.fs.readdir(projectsRoot)
    // When the same session id exists in multiple project dirs (rare
    // but possible if the user copied state, or two cwds share a UUID),
    // pick the newest. readdir order is filesystem-dependent and would
    // otherwise be non-deterministic across reboots.
    const candidates: Array<{ path: string; mtime: number }> = []
    for (const p of projects) {
      const candidate = join(projectsRoot, p, `${sessionId}.jsonl`)
      if (!ctx.fs.existsSync(candidate)) continue
      try {
        const s = await ctx.fs.stat(candidate)
        candidates.push({ path: candidate, mtime: s.mtimeMs })
      } catch {
        /* skip — stat failed mid-iteration */
      }
    }
    if (candidates.length === 0) return null
    candidates.sort((a, b) => b.mtime - a.mtime)
    return candidates[0]?.path ?? null
  } catch {
    /* projects root missing — return null */
  }
  return null
}

/** Read the latest custom-title (preferred) or ai-title from a JSONL.
 *
 *  Walks lines in reverse and returns on the first match so the typical
 *  call reads only the last few KB of a multi-MB file. Called from every
 *  heartbeat tick, every tool handler, and every doctor / publish /
 *  broadcast peer enumeration — must stay sublinear in file size. */
export async function readDisplayNameForJsonl(
  ctx: Pick<Context, 'fs'>,
  jsonl: string | null,
): Promise<string | null> {
  if (!jsonl) return null
  // Collect lines into an array so we can walk in reverse. The full read
  // is still bounded by the file size, but the parse cost (which dominates
  // when there are many matching lines) drops to one parse on the typical
  // case (the latest custom-title appears at the end of the file).
  const lines: string[] = []
  try {
    for await (const line of ctx.fs.readLines(jsonl)) {
      lines.push(line)
    }
  } catch {
    return null
  }
  // Walk backwards. Return the first custom-title we find. If we exhaust
  // without finding one, fall back to the first ai-title from the back.
  let aiTitleFallback: string | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    if (!(line.includes('"custom-title"') || line.includes('"ai-title"'))) continue
    try {
      const ev = JSON.parse(line)
      if (ev?.type === 'custom-title' && typeof ev.customTitle === 'string') {
        return ev.customTitle
      }
      if (aiTitleFallback === null && ev?.type === 'ai-title' && typeof ev.aiTitle === 'string') {
        aiTitleFallback = ev.aiTitle
      }
    } catch {
      /* skip unparseable line */
    }
  }
  return aiTitleFallback
}

/**
 * Resolve this session's display name without caching. Reads the JSONL
 * each call; prefer {@link resolveMyNameCached} on hot paths.
 *
 * @returns The custom title set via `/rename`, falling back to the
 *   auto-generated ai-title, falling back to the UUID prefix.
 */
export async function resolveMyName(
  ctx: Pick<Context, 'fs' | 'env' | 'proc'>,
  identity: Identity,
  projectsRoot: string,
): Promise<string> {
  if (!identity.meIsUuid) return identity.me
  const jsonl = await findJsonlForSession(ctx, projectsRoot, identity.me)
  return (await readDisplayNameForJsonl(ctx, jsonl)) || `${identity.me.slice(0, 8)}…`
}

/** Cached resolveMyName for hot paths (heartbeat tick, tool handlers).
 *  Invalidates when the underlying JSONL's mtime changes — that's the
 *  only mutation channel for display name (the agent's /rename writes
 *  a custom-title event into the JSONL, which bumps the file mtime). */
export interface NameCache {
  /** Cached name. */
  value: string | null
  /** mtime of the JSONL at the time of cache. */
  mtimeMs: number
  /** Cached JSONL path (so we don't re-search for it). */
  jsonlPath: string | null
}

/** Build an empty {@link NameCache}. The bun keeps one of these and
 *  passes it to every {@link resolveMyNameCached} call. */
export function createNameCache(): NameCache {
  return { value: null, mtimeMs: 0, jsonlPath: null }
}

/**
 * Cached {@link resolveMyName} suitable for hot paths.
 *
 * @remarks
 * Returns the cached value when the JSONL mtime is unchanged since the
 * last call; otherwise re-scans. Hot path: every heartbeat tick + every
 * tool handler.
 */
export async function resolveMyNameCached(
  ctx: Pick<Context, 'fs' | 'env' | 'proc' | 'clock'>,
  identity: Identity,
  projectsRoot: string,
  cache: NameCache,
): Promise<string> {
  if (!identity.meIsUuid) return identity.me
  // Locate the JSONL (cached path on hot path; re-discover on first call
  // or if the previous lookup failed).
  let jsonl = cache.jsonlPath
  if (jsonl === null) {
    jsonl = await findJsonlForSession(ctx, projectsRoot, identity.me)
    cache.jsonlPath = jsonl
  }
  if (!jsonl) {
    return cache.value ?? `${identity.me.slice(0, 8)}…`
  }
  // mtime-based invalidation. If the JSONL hasn't changed since the last
  // cached value, return the cache. Else re-scan.
  let currentMtime = 0
  try {
    currentMtime = (await ctx.fs.stat(jsonl)).mtimeMs
  } catch {
    return cache.value ?? `${identity.me.slice(0, 8)}…`
  }
  if (cache.value !== null && currentMtime === cache.mtimeMs) {
    return cache.value
  }
  const name = (await readDisplayNameForJsonl(ctx, jsonl)) || `${identity.me.slice(0, 8)}…`
  cache.value = name
  cache.mtimeMs = currentMtime
  return name
}

/** Three-layer self-exclusion. Each layer is independent; the function
 *  short-circuits on the first match. UUID is the cheapest and most reliable;
 *  name covers display-rename collisions; pid covers oddball cases where the
 *  same bun's heartbeat surfaces under a foreign dir. */
export async function isSelf(
  ctx: Pick<Context, 'fs' | 'proc'>,
  stateRoot: string,
  me: string,
  myName: string | null,
  peerId: string,
  peerName: string | null,
): Promise<boolean> {
  if (peerId === me) return true
  if (peerName !== null && myName !== null && peerName === myName) return true
  try {
    const raw = await ctx.fs.readFile(join(stateRoot, peerId, '.heartbeat'))
    const hb = JSON.parse(raw)
    if (typeof hb?.pid === 'number' && hb.pid === ctx.proc.pid()) return true
  } catch {
    /* no heartbeat / parse failure — fall through */
  }
  return false
}

/** A session dir present under the state root. Returned by
 *  {@link listKnownInstances} and consumed by every peer-enumeration
 *  path (presence, broadcast, publish, doctor). */
export interface KnownInstance {
  id: string
  isUuid: boolean
  name: string | null
  lastActive: number
}

/** Enumerate every peer dir under the state root, resolving display
 *  name for UUID-shaped entries. Skips dotfiles and non-directories.
 *  Caller pairs this with {@link isLivePeer} + {@link isSelf} for the
 *  fan-out target set. */
export async function listKnownInstances(
  ctx: Pick<Context, 'fs' | 'env' | 'proc'>,
  stateRoot: string,
  projectsRoot: string,
): Promise<KnownInstance[]> {
  const out: KnownInstance[] = []
  let entries: string[]
  try {
    entries = await ctx.fs.readdir(stateRoot)
  } catch {
    return out
  }
  for (const id of entries) {
    if (id.startsWith('.')) continue
    const dir = join(stateRoot, id)
    let isDir = false
    try {
      isDir = (await ctx.fs.stat(dir)).isDirectory
    } catch {
      continue
    }
    if (!isDir) continue
    const looksLikeUuid = UUID_RE.test(id)
    let name: string | null = null
    if (looksLikeUuid) {
      const jsonl = await findJsonlForSession(ctx, projectsRoot, id)
      name = await readDisplayNameForJsonl(ctx, jsonl)
    }
    let lastActive = 0
    try {
      const lockSt = await ctx.fs.stat(join(dir, '.lock'))
      lastActive = Math.max(lastActive, lockSt.mtimeMs)
    } catch {
      /* no lock */
    }
    out.push({ id, isUuid: looksLikeUuid, name, lastActive })
  }
  return out
}

/** Resolve a recipient handle to a known instance dir.
 *
 *  Order: exact UUID > display name (live preferred) > legacy dirname >
 *  UUID prefix > fall-through (creates a new dir). Display-name match
 *  must run before legacy-dirname match: a non-UUID dir whose name
 *  collides with a live session's display name would otherwise shadow
 *  the live session. */
export async function resolveRecipient(
  ctx: Pick<Context, 'fs' | 'env' | 'proc'>,
  stateRoot: string,
  projectsRoot: string,
  target: string,
): Promise<{ id: string; name: string | null }> {
  const known = await listKnownInstances(ctx, stateRoot, projectsRoot)
  const now = ctx.proc as { pidAlive(p: number): Promise<boolean> } & { clock?: never }
  // For age comparison we reach back to clock via a separate helper to avoid
  // widening ctx; the call site passes its own clock.
  const heartbeatAge = async (id: string): Promise<number> => {
    try {
      const s = await ctx.fs.stat(join(stateRoot, id, '.heartbeat'))
      return Date.now() - s.mtimeMs
    } catch {
      return Number.POSITIVE_INFINITY
    }
  }
  void now
  // 1) exact UUID match
  const exactUuid = known.find(k => k.isUuid && k.id === target)
  if (exactUuid) return { id: exactUuid.id, name: exactUuid.name }
  // 2) display-name match — prefer LIVE, fall back to most-recent-active
  const byName = known.filter(k => k.name === target)
  if (byName.length > 0) {
    const withAges = await Promise.all(
      byName.map(async k => ({ k, age: await heartbeatAge(k.id) })),
    )
    const live = withAges.filter(x => x.age <= LIVE_MAX_AGE_MS)
    const pool = live.length > 0 ? live : withAges
    const sorted = pool.sort((a, b) => a.age - b.age || b.k.lastActive - a.k.lastActive)
    const pick = sorted[0]
    if (pick) return { id: pick.k.id, name: pick.k.name }
  }
  // 3) legacy dirname match (non-UUID, no live session claims this name)
  const legacy = known.find(k => !k.isUuid && k.id === target)
  if (legacy) return { id: legacy.id, name: legacy.name }
  // 4) session-id prefix match (unique)
  const prefix = known.filter(k => k.isUuid && k.id.startsWith(target))
  if (prefix.length === 1) {
    const p = prefix[0]
    if (p) return { id: p.id, name: p.name }
  }
  if (prefix.length > 1) {
    throw new Error(
      `ambiguous recipient "${target}" — matches ${prefix.length} session-id prefixes.`,
    )
  }
  // 5) fall-through: send to not-yet-running session. Sanitize first.
  sanitizeId(target, 'resolveRecipient fall-through')
  return { id: target, name: null }
}

const MENTION_RE = /(?:^|[\s(,;:!?])@([A-Za-z0-9._-]+)/g

/** Parse @-mentions out of a body and resolve each to a peer id. Skips
 *  self-mentions (@me, @<my-name>, @<my-uuid-prefix> of ≥8 chars) and
 *  unresolved handles (typos, hallucinated names). */
export async function parseMentions(
  ctx: Pick<Context, 'fs' | 'env' | 'proc'>,
  stateRoot: string,
  projectsRoot: string,
  me: string,
  myName: string,
  body: string,
): Promise<string[]> {
  const handles = new Set<string>()
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
  while ((m = MENTION_RE.exec(body)) !== null) {
    const handle = m[1]
    if (handle) handles.add(handle)
  }
  if (handles.size === 0) return []
  const known = await listKnownInstances(ctx, stateRoot, projectsRoot)
  const mentioned = new Set<string>()
  for (const handle of handles) {
    if (handle === 'me' || handle === me || handle === myName) continue
    if (me.startsWith(handle) && handle.length >= 8) continue
    const matchUuid = known.find(k => k.isUuid && k.id === handle)
    if (matchUuid) {
      mentioned.add(matchUuid.id)
      continue
    }
    const matchName = known.find(k => k.name === handle)
    if (matchName) {
      mentioned.add(matchName.id)
      continue
    }
    const pfx = known.filter(k => k.isUuid && k.id.startsWith(handle))
    if (pfx.length === 1) {
      const only = pfx[0]
      if (only) mentioned.add(only.id)
    }
  }
  return [...mentioned]
}
