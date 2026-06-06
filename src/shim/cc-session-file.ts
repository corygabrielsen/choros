import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { UUID_RE } from '#choros/identity.ts'

/** Validated subset of Claude Code's `~/.claude/sessions/<PID>.json`
 *  metadata. CC writes this file at session startup and updates it on
 *  `/rename` and status changes. Filename equals the file's `pid`
 *  field (1:1 invariant verified across the live-session sample). */
export interface CcSessionFile {
  /** CC's session UUID. Authoritative — what every other CC surface
   *  uses to identify this session. */
  sessionId: string
  /** Display name from `/rename` or `--resume "<name>"`. Null on
   *  fresh sessions and on `sdk-cli` entrypoints (which can't be
   *  renamed). */
  name: string | null
  /** CC's working directory at session start. */
  cwd: string
  /** Process id of the CC binary. Must equal the lookup PID; the
   *  cross-check guards against stale or PID-recycled files. */
  pid: number
}

/** Locate CC's per-process session metadata. CC writes
 *  `~/.claude/sessions/<PID>.json` for every interactive session;
 *  filename is the CC process's PID. */
export function ccSessionFilePath(home: string, ccPid: number): string {
  return join(home, '.claude', 'sessions', `${ccPid}.json`)
}

/** mtime+size-keyed cache of the most-recently-resolved CC session
 *  file. Heartbeats poll this every tick; the file only changes on
 *  /rename or status transitions, so 99% of polls hit the cache.
 *  mtime alone is insufficient (millisecond precision can collide
 *  on same-ms writes); size catches any rewrite that landed in the
 *  same ms with different content. */
interface FsCache {
  path: string
  mtimeMs: number
  size: number
  value: CcSessionFile | null
}
let cache: FsCache | null = null

/** Reset the cc-session-file mtime cache. Tests call this to keep
 *  per-test state isolated; production never does. */
export function _resetCcSessionFileCache(): void {
  cache = null
}

/** Read CC's session metadata for `ccPid`. Returns null when the
 *  file doesn't exist (not launched under CC), is malformed
 *  (mid-write race, corruption), is missing required fields, or
 *  has a `pid` field that doesn't match `ccPid` (stale file from a
 *  recycled PID — CC overwrites at startup, so a mismatch means
 *  this file isn't for the requested process).
 *
 *  Defensive on every field: TypeScript's structural type comes
 *  from the JSON, so a typo or schema drift in CC would
 *  silently feed bad data into the daemon without these checks. */
export async function readCcSessionFile(
  home: string,
  ccPid: number,
): Promise<CcSessionFile | null> {
  if (!Number.isFinite(ccPid) || ccPid <= 0) return null
  const path = ccSessionFilePath(home, ccPid)
  let mtimeMs: number
  let size: number
  try {
    const st = await stat(path)
    mtimeMs = st.mtimeMs
    size = st.size
  } catch {
    return null
  }
  if (cache && cache.path === path && cache.mtimeMs === mtimeMs && cache.size === size) {
    return cache.value
  }
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const parsed = parseCcSessionFile(raw, ccPid)
  cache = { path, mtimeMs, size, value: parsed }
  return parsed
}

/** Parse + validate the JSON payload. Exported separately so tests
 *  can exercise edge cases (malformed JSON, missing fields, wrong
 *  `pid`, oversized `name`) without staging real files. */
export function parseCcSessionFile(raw: string, expectedPid: number): CcSessionFile | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  if (typeof o.sessionId !== 'string' || !UUID_RE.test(o.sessionId)) return null
  if (typeof o.cwd !== 'string' || o.cwd.length === 0) return null
  if (typeof o.pid !== 'number' || o.pid !== expectedPid) return null
  const name = typeof o.name === 'string' && o.name.length > 0 ? o.name : null
  return { sessionId: o.sessionId, name, cwd: o.cwd, pid: o.pid }
}

/** Read CC's session file with bounded startup retry. CC may write
 *  the file shortly after spawning the MCP child; the retry tolerates
 *  that race without permanently degrading to the legacy heuristic.
 *  Cost: at most `attempts * waitMs` ms of startup latency in the
 *  cold-path; first-attempt hit costs one stat + small JSON parse. */
export async function readCcSessionFileWithRetry(
  home: string,
  ccPid: number,
  opts: { attempts?: number; waitMs?: number } = {},
): Promise<CcSessionFile | null> {
  const attempts = opts.attempts ?? 4
  const waitMs = opts.waitMs ?? 250
  for (let i = 0; i < attempts; i++) {
    const result = await readCcSessionFile(home, ccPid)
    if (result !== null) return result
    if (i + 1 < attempts) await sleep(waitMs)
  }
  return null
}
