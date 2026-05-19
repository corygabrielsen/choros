#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { spawn, type ChildProcess, execSync } from 'node:child_process'
import { readFile, readdir, mkdir, writeFile, unlink, stat, rename, open } from 'node:fs/promises'
import { existsSync, unlinkSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, basename as pathBasename } from 'node:path'
import { homedir, hostname } from 'node:os'

const BODY_CAP_BYTES = 64 * 1024

/** Resolve the choros state root. Order:
 *    1. $CHOROS_STATE_HOME (explicit override)
 *    2. $XDG_STATE_HOME/choros
 *    3. ~/.local/state/choros
 *  Mirrors the ooda-* convention. State is OURS; nothing under ~/.claude. */
function resolveStateRoot(): string {
  if (process.env.CHOROS_STATE_HOME) return process.env.CHOROS_STATE_HOME
  if (process.env.XDG_STATE_HOME) return join(process.env.XDG_STATE_HOME, 'choros')
  return join(homedir(), '.local', 'state', 'choros')
}
const CHOROS_ROOT = resolveStateRoot()
// CC's JSONL transcripts. Read-only consumer — Anthropic owns this path.
const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')

// Heartbeat: server touches .heartbeat every HEARTBEAT_INTERVAL_MS. Senders
// stat a recipient's .heartbeat to distinguish "MCP alive" from "MCP dead";
// stale heartbeat ⟹ push notification will not fire even though filesystem
// delivery succeeds. LIVE_MAX_AGE_MS is the threshold for "alive".
const HEARTBEAT_INTERVAL_MS = 30_000
const LIVE_MAX_AGE_MS = 90_000

// Swallow EPIPE on stdout. Bun's writeFast throws an unhandled error event
// when the parent (Claude Code) closes the read end of our stdout pipe. Without
// a listener this terminates the bun process before Promise.race timeout fires.
// Two valid responses: (a) exit immediately, letting CC respawn us, or (b)
// swallow and let the timer-based wedge detector run. We pick (a) — EPIPE means
// CC has explicitly closed the pipe; respawn is the only correct recovery. The
// timer-based path handles the wedged-but-not-disconnected case.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e?.code === 'EPIPE') {
    process.stderr.write(`[choros] stdout EPIPE — parent closed read end; exiting so CC can respawn\n`)
    process.exit(0)  // existing exit listener releases the lock
  }
  process.stderr.write(`[choros] stdout error: ${e}\n`)
})

// Push delivery timeout. The MCP SDK's StdioServerTransport wraps
// process.stdout.write() in a callback-style Promise that only resolves on a
// successful write callback. On EPIPE (parent closed the read end) the stream
// emits 'error' and the Promise NEVER settles — neither resolves nor rejects.
// Without a timeout the maybeEmit() coroutine hangs forever, the .seen sidecar
// has already been written, and the message vanishes into the void with no
// signal. Wrap every notification in Promise.race(timeout); count consecutive
// timeouts; emit a .wedged marker for external monitors after a threshold.
const PUSH_TIMEOUT_MS = 5_000
const WEDGE_TIMEOUT_THRESHOLD = 3
// How long to wait for CC to record the msg_id in its own JSONL after
// mcp.notification() resolves. Empirically delivery → JSONL is ~40 ms when
// CC actually processes the push; this generous window tolerates flushes and
// busy CC states. A miss after this window is a strong signal that CC
// silently dropped the notification.
const JSONL_VERIFY_TIMEOUT_MS = 5_000

// --- Shared helpers ---

/** Validate an identifier that's about to become part of a filesystem path.
 *  Rejects path separators, traversal, NUL, and control chars. Used at every
 *  boundary where untrusted input (msg_id, recipient handle, env override,
 *  body-derived from_session) flows into join(CHOROS_ROOT, …).
 *
 *  Returns the input if safe, or throws. Callers must throw or surface to
 *  user — never silently fall through to a possibly-attacker-controlled path.
 */
function sanitizeId(input: string, label: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`${label}: empty or non-string identifier`)
  }
  if (input.length > 256) {
    throw new Error(`${label}: identifier exceeds 256 chars`)
  }
  if (/[\x00-\x1f\x7f/\\]/.test(input)) {
    throw new Error(`${label}: contains path separator, control char, or NUL`)
  }
  if (input === '.' || input === '..' || input.startsWith('.')) {
    // Dot-prefix would collide with our hidden state files (.heartbeat, …).
    // Disallow at the API boundary; internal callers writing .heartbeat etc.
    // construct those paths directly, not through this helper.
    throw new Error(`${label}: must not start with '.'`)
  }
  return input
}

/** Check whether a candidate peer (id, optional display name) is actually us.
 *  Mirrors the three-layer self-exclusion used in broadcastPresence /
 *  handleDoctorRequest. Centralized so send/react/parseMentions/writeAck all
 *  agree on "who is me."
 *
 *  Async because we may need to read the peer's .heartbeat to check the pid
 *  match. Callers that already have name resolved can pass it; pass null to
 *  skip the name match (used by send where only id is known).
 */
async function isSelf(peerId: string, peerName: string | null = null): Promise<boolean> {
  if (peerId === ME) return true
  if (peerName !== null) {
    const myName = await resolveMyName()
    if (peerName === myName) return true
  }
  // Third layer: peer's heartbeat pid == our pid. Rare but defensive.
  try {
    const hb = JSON.parse(await readFile(join(CHOROS_ROOT, peerId, '.heartbeat'), 'utf8'))
    if (hb?.pid === process.pid) return true
  } catch { /* no/unparseable heartbeat — fall through */ }
  return false
}

/** True if the OS still has a process for this pid. Linux-specific (via
 *  /proc/<pid>); on missing /proc, returns true (fail-open — better to
 *  list a maybe-dead peer than hide a live one). A clean bun exit drops
 *  /proc/<pid> immediately, so this distinguishes a peer's bun being
 *  truly alive from a peer whose .heartbeat mtime simply hasn't aged
 *  out yet. Cheap: one stat. */
async function pidAlive(pid: number | null | undefined): Promise<boolean> {
  if (!pid || typeof pid !== 'number') return false
  try { await stat(`/proc/${pid}`); return true }
  catch (e: any) {
    if (e?.code === 'ENOENT') return false
    return true  // EACCES etc. — assume alive
  }
}

/** Liveness check used for presence/roster/broadcast eligibility. A peer
 *  is "live" only if (a) heartbeat is fresh AND (b) its bun process is
 *  actually running. The bun-alive check defends against the stale-heartbeat
 *  pitfall: a freshly-exited bun's heartbeat is still <LIVE_MAX_AGE_MS old
 *  but the process is gone, so the peer should not appear in rosters or
 *  receive broadcast/publish fan-out. */
async function isLivePeer(peerId: string): Promise<boolean> {
  try {
    const hbRaw = await readFile(join(CHOROS_ROOT, peerId, '.heartbeat'), 'utf8')
    const hbSt = await stat(join(CHOROS_ROOT, peerId, '.heartbeat'))
    if (Date.now() - hbSt.mtimeMs > LIVE_MAX_AGE_MS) return false
    let hb: any
    try { hb = JSON.parse(hbRaw) } catch { return false }
    return await pidAlive(hb?.pid)
  } catch { return false }
}

/** Wrap a promise with a timeout. The setTimeout is cleared as soon as the
 *  promise settles, so no zombie timer accumulates on hot paths. Returns
 *  'ok' if the promise resolved before the timeout, 'timeout' otherwise.
 *  The underlying promise's rejection is surfaced via stderr (so it isn't
 *  silently swallowed by the .then(() => 'ok') antipattern).
 */
async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  label = 'op',
): Promise<'ok' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>(r => {
    timer = setTimeout(() => r('timeout'), timeoutMs)
  })
  try {
    const result = await Promise.race<'ok' | 'timeout'>([
      task.then(() => 'ok' as const, err => {
        process.stderr.write(`[choros] ${label} rejected: ${err?.message ?? err}\n`)
        return 'ok' as const  // treat as resolved-with-error; sender already logged
      }),
      timeout,
    ])
    return result
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Atomic write — write to a sibling tmp file and rename. Required for every
 *  state file that peers stat/read concurrently (.heartbeat, .agent_state,
 *  .subscriptions, .wedged, sidecars). Without this, readers can see a
 *  half-written payload.
 */
async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, content)
  await rename(tmp, path)
}

// --- Identity: session UUID (preferred) or legacy fallbacks ---
//
// Claude Code does NOT propagate CLAUDE_CODE_SESSION_ID to MCP server subprocesses
// (confirmed empirically — it's set for Bash tool subprocesses but not for mcpServers).
// CLAUDE_PROJECT_DIR IS propagated. Workaround: at boot, find the newest JSONL in our
// project dir — that's almost certainly our session (Claude Code writes session
// metadata to its JSONL on startup, within ms of spawning MCP servers).

function projectsRootFor(cwd: string): string {
  return join(PROJECTS_ROOT, cwd.replace(/\//g, '-'))
}

async function newestSessionJsonl(projectDir: string): Promise<string | null> {
  try {
    const files = await readdir(projectDir)
    const jsonls = files.filter(f =>
      f.endsWith('.jsonl') &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(f),
    )
    if (jsonls.length === 0) return null
    const withMtime = await Promise.all(jsonls.map(async f => {
      const s = await stat(join(projectDir, f))
      return { name: f, mtime: s.mtimeMs }
    }))
    withMtime.sort((a, b) => b.mtime - a.mtime)
    return withMtime[0].name.replace(/\.jsonl$/, '')
  } catch {
    return null
  }
}

async function resolveIdentity(): Promise<{ id: string; source: string; isUuid: boolean }> {
  const explicit = process.env.CHOROS_IDENTITY?.trim()
  if (explicit) {
    sanitizeId(explicit, 'CHOROS_IDENTITY')
    return { id: explicit, source: 'CHOROS_IDENTITY', isUuid: false }
  }

  const sessionId = process.env.CLAUDE_CODE_SESSION_ID?.trim()
  if (sessionId) return { id: sessionId, source: 'CLAUDE_CODE_SESSION_ID', isUuid: true }

  // Fallback: newest JSONL in our project dir. Wait up to ~2s for it to appear
  // (Claude Code may write the JSONL slightly after spawning the MCP server).
  const projectCwd = process.env.CLAUDE_PROJECT_DIR?.trim()
    || process.env.PWD?.trim()
    || process.cwd()
  const projectDir = projectsRootFor(projectCwd)
  for (let i = 0; i < 10; i++) {
    const newest = await newestSessionJsonl(projectDir)
    if (newest) return { id: newest, source: 'newest-jsonl-in-project-dir', isUuid: true }
    await new Promise(r => setTimeout(r, 200))
  }

  // Last-resort basename fallbacks. Two sessions sharing the same cwd would
  // collide on identity here — known edge case, kept as a fallback because
  // the env-var route covers the disambiguating case. Sanitize regardless.
  const projectDirBase = process.env.CLAUDE_PROJECT_DIR?.trim()
  if (projectDirBase) {
    const id = pathBasename(projectDirBase)
    sanitizeId(id, 'CLAUDE_PROJECT_DIR basename')
    return { id, source: 'CLAUDE_PROJECT_DIR', isUuid: false }
  }
  const pwd = process.env.PWD?.trim()
  if (pwd) {
    const id = pathBasename(pwd)
    sanitizeId(id, 'PWD basename')
    return { id, source: 'PWD', isUuid: false }
  }
  const id = pathBasename(process.cwd())
  sanitizeId(id, 'process.cwd() basename')
  return { id, source: 'process.cwd()', isUuid: false }
}

const { id: ME, source: ID_SOURCE, isUuid: ME_IS_UUID } = await resolveIdentity()
const MY_ROOT = join(CHOROS_ROOT, ME)
const MY_INBOX = join(MY_ROOT, 'inbox')
const MY_READ = join(MY_INBOX, 'read')
const MY_SENT = join(MY_ROOT, 'sent')
const MY_ACKS = join(MY_ROOT, 'sent_acks')
const MY_PRESENCE = join(MY_ROOT, 'presence')
const LOCK_PATH = join(MY_ROOT, '.lock')
const HEARTBEAT_PATH = join(MY_ROOT, '.heartbeat')
const WEDGE_PATH = join(MY_ROOT, '.wedged')
const AGENT_STATE_PATH = join(MY_ROOT, '.agent_state')
const SUBSCRIPTIONS_PATH = join(MY_ROOT, '.subscriptions')

await mkdir(MY_INBOX, { recursive: true })
await mkdir(MY_READ, { recursive: true })
await mkdir(MY_SENT, { recursive: true })
await mkdir(MY_ACKS, { recursive: true })
await mkdir(MY_PRESENCE, { recursive: true })

// --- Display-name resolver: read latest custom-title (then ai-title) from JSONL ---

function encodedCwd(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

async function findJsonlForSession(sessionId: string): Promise<string | null> {
  // Best-effort fast path: encoded(cwd at boot).
  const pwd = process.env.PWD?.trim() || process.cwd()
  const fast = join(PROJECTS_ROOT, encodedCwd(pwd), `${sessionId}.jsonl`)
  if (existsSync(fast)) return fast
  // Fallback: scan project dirs.
  try {
    const projects = await readdir(PROJECTS_ROOT)
    for (const p of projects) {
      const candidate = join(PROJECTS_ROOT, p, `${sessionId}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
  } catch {}
  return null
}

async function readDisplayNameForJsonl(jsonl: string | null): Promise<string | null> {
  if (!jsonl) return null
  let customTitle: string | null = null
  let aiTitle: string | null = null
  try {
    const rl = createInterface({ input: createReadStream(jsonl), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line) continue
      // Cheap pre-filter — avoid JSON parsing every record.
      if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) continue
      try {
        const ev = JSON.parse(line)
        if (ev?.type === 'custom-title' && typeof ev.customTitle === 'string') customTitle = ev.customTitle
        else if (ev?.type === 'ai-title' && typeof ev.aiTitle === 'string') aiTitle = ev.aiTitle
      } catch {}
    }
  } catch {}
  return customTitle || aiTitle
}

async function resolveMyName(): Promise<string> {
  if (!ME_IS_UUID) return ME  // legacy / env-override identity is its own name
  const jsonl = await findJsonlForSession(ME)
  return (await readDisplayNameForJsonl(jsonl)) || `${ME.slice(0, 8)}…`
}

// --- Recipient resolver: name OR session-id OR legacy dirname → directory ---

interface KnownInstance {
  id: string
  isUuid: boolean
  name: string | null
  lastActive: number  // epoch ms; 0 if unknown
}

async function listKnownInstances(): Promise<KnownInstance[]> {
  const out: KnownInstance[] = []
  let entries: string[]
  try { entries = await readdir(CHOROS_ROOT) } catch { return out }
  for (const id of entries) {
    if (id.startsWith('.')) continue
    const dir = join(CHOROS_ROOT, id)
    let isDir = false
    try { isDir = (await stat(dir)).isDirectory() } catch { continue }
    if (!isDir) continue
    const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    let name: string | null = null
    if (looksLikeUuid) {
      const jsonl = await findJsonlForSession(id)
      name = await readDisplayNameForJsonl(jsonl)
    }
    let lastActive = 0
    try {
      const lockSt = await stat(join(dir, '.lock'))
      lastActive = Math.max(lastActive, lockSt.mtimeMs)
    } catch {}
    try {
      const lsSt = await stat(join(dir, '.last_seen'))
      lastActive = Math.max(lastActive, lsSt.mtimeMs)
    } catch {}
    out.push({ id, isUuid: looksLikeUuid, name, lastActive })
  }
  return out
}

// Resolver precedence — exact-UUID > live-display-name > legacy-dirname >
// UUID-prefix > fall-through. The v0.4 resolver had `id === target` as step 1,
// which silently matched legacy non-UUID dirs (e.g. $CHOROS_ROOT/skills/)
// before display-name lookup. A live session named "skills" via /rename was
// forever shadowed by the dead legacy dir. v0.5 splits the id-match into two
// tiers: UUID-shaped ids match first; non-UUID ids only match if no live
// session claims the target as its display name.
async function resolveRecipient(target: string): Promise<{ id: string; name: string | null }> {
  const known = await listKnownInstances()
  const now = Date.now()
  const heartbeatAge = async (id: string): Promise<number> => {
    try { return now - (await stat(join(CHOROS_ROOT, id, '.heartbeat'))).mtimeMs }
    catch { return Infinity }
  }

  // 1) exact UUID match (UUID-shaped target hitting a UUID-shaped dir)
  const exactUuid = known.find(k => k.isUuid && k.id === target)
  if (exactUuid) return { id: exactUuid.id, name: exactUuid.name }

  // 2) display-name match — prefer LIVE instance, fall back to most-recent-active.
  const byName = known.filter(k => k.name === target)
  if (byName.length > 0) {
    const withAges = await Promise.all(byName.map(async k => ({ k, age: await heartbeatAge(k.id) })))
    const live = withAges.filter(x => x.age <= LIVE_MAX_AGE_MS)
    const pick = (live.length > 0 ? live : withAges)
      .sort((a, b) => a.age - b.age || b.k.lastActive - a.k.lastActive)[0].k
    return { id: pick.id, name: pick.name }
  }

  // 3) legacy dirname match (non-UUID dir name). No live session claims this
  //    name as display-name (step 2 missed), so the legacy dir is the best
  //    available answer. Warn if the dir has no heartbeat — the sender's
  //    "MCP live" check will also show this, but a stderr line makes the
  //    routing visible in the server log too.
  const legacy = known.find(k => !k.isUuid && k.id === target)
  if (legacy) {
    const age = await heartbeatAge(legacy.id)
    if (!isFinite(age)) {
      process.stderr.write(
        `[choros] resolveRecipient("${target}") → legacy dir "${legacy.id}" with NO heartbeat. ` +
        `Message will land on disk but no live MCP server will see it.\n`,
      )
    }
    return { id: legacy.id, name: legacy.name }
  }

  // 4) session-id prefix match (unique)
  const prefixMatches = known.filter(k => k.isUuid && k.id.startsWith(target))
  if (prefixMatches.length === 1) return { id: prefixMatches[0].id, name: prefixMatches[0].name }
  if (prefixMatches.length > 1) {
    throw new Error(`ambiguous recipient "${target}" — matches ${prefixMatches.length} session-id prefixes. Use longer prefix or full id.`)
  }

  // 5) no match — create a new dir under this name (allows sending to not-yet-running sessions).
  //    Sanitize before returning so the fall-through can't be weaponized for
  //    path traversal via send(to: "../../etc/passwd").
  sanitizeId(target, 'resolveRecipient fall-through')
  return { id: target, name: null }
}

// --- Lockfile: refuse to start if another live MCP server holds this identity ---

async function takeLock() {
  const payload = JSON.stringify({ pid: process.pid, started: new Date().toISOString() })
  try {
    await writeFile(LOCK_PATH, payload, { flag: 'wx' })
    return
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e
  }
  let holder: { pid: number; started: string }
  try { holder = JSON.parse(await readFile(LOCK_PATH, 'utf8')) }
  catch { await writeFile(LOCK_PATH, payload); return }
  let alive = false
  try { process.kill(holder.pid, 0); alive = true } catch {}
  if (alive && holder.pid !== process.pid) {
    process.stderr.write(
      `[choros] identity "${ME}" locked by PID ${holder.pid} (started ${holder.started}).\n` +
      `[choros] This almost never happens with v3 (identity is per-session UUID).\n` +
      `[choros] If you genuinely need a sibling, set CHOROS_IDENTITY=<unique>.\n`,
    )
    process.exit(1)
  }
  await writeFile(LOCK_PATH, payload)
}

await takeLock()

// Mutable holder so exit handlers (defined here, before spawn) can reach the
// inotifywait child. Without explicit kill, watcher is reparented to init on
// bun exit and lingers as an orphan, consuming inotify watch slots. Observed
// 14 orphan inotifywaits in production from accumulated CC session closures.
let watcherRef: ChildProcess | null = null

function killWatcher() {
  if (watcherRef && watcherRef.pid && !watcherRef.killed) {
    try { watcherRef.kill('SIGTERM') } catch {}
  }
  // ackWatcherRef and presenceWatcherRef declared later; reference via
  // closure-on-eval is fine in exit handlers because cleanup only runs after
  // bun is fully booted. Guard with typeof in case we exit before they're set.
  try {
    // @ts-expect-error — late-bound module-level let
    if (typeof ackWatcherRef !== 'undefined' && ackWatcherRef && ackWatcherRef.pid && !ackWatcherRef.killed) {
      // @ts-expect-error
      ackWatcherRef.kill('SIGTERM')
    }
  } catch {}
  try {
    // @ts-expect-error — late-bound module-level let
    if (typeof presenceWatcherRef !== 'undefined' && presenceWatcherRef && presenceWatcherRef.pid && !presenceWatcherRef.killed) {
      // @ts-expect-error
      presenceWatcherRef.kill('SIGTERM')
    }
  } catch {}
  try {
    // @ts-expect-error — late-bound module-level let
    if (typeof readWatcherRef !== 'undefined' && readWatcherRef && readWatcherRef.pid && !readWatcherRef.killed) {
      // @ts-expect-error
      readWatcherRef.kill('SIGTERM')
    }
  } catch {}
}

function releaseLock() {
  try { unlinkSync(LOCK_PATH) } catch {}
}

function cleanShutdown() {
  killWatcher()
  releaseLock()
}

process.on('exit', cleanShutdown)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, async () => {
    // Best-effort goodbye to live peers so the swarm sees us leave promptly.
    // Bounded so we don't hang shutdown on a wedged peer FS.
    try {
      await Promise.race([
        broadcastPresence('goodbye'),
        new Promise(r => setTimeout(r, 1500)),
      ])
    } catch {}
    cleanShutdown()
    process.exit(0)
  })
}

// Reap orphan inotifywaits left by previous bun lifetimes. An inotifywait
// is orphaned when its parent bun is dead (PPID=1 after init-adoption, OR
// PPID points at a process that no longer exists or isn't bun running this
// server). Each Claude Code session-close currently leaves one such orphan;
// without cleanup we eventually hit max_user_instances=128 inotify slots.
// Conservative — only kills inotifywaits watching $CHOROS_ROOT/*/inbox.
function reapOrphanWatchers() {
  let out: string
  try {
    out = execSync('ps -eo pid=,ppid=,args=', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch { return }

  const lines = out.split('\n').map(l => l.trim()).filter(Boolean)
  const byPid = new Map<number, { ppid: number; args: string }>()
  for (const line of lines) {
    const m = line.match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    byPid.set(parseInt(m[1], 10), { ppid: parseInt(m[2], 10), args: m[3] })
  }

  function isLiveBun(pid: number): boolean {
    const p = byPid.get(pid)
    return !!p && p.args.includes('bun ') && p.args.includes('choros/server.ts')
  }

  let killed = 0
  for (const [pid, info] of byPid) {
    if (!info.args.includes('inotifywait')) continue
    if (!info.args.includes(`${CHOROS_ROOT}/`)) continue
    // Match all per-session state dirs the bun watches.
    if (
      !info.args.includes('/inbox')
      && !info.args.includes('/sent_acks')
      && !info.args.includes('/presence')
    ) continue
    if (isLiveBun(info.ppid)) continue  // legitimate child of a live bun
    try { process.kill(pid, 'SIGTERM'); killed++ } catch {}
  }
  if (killed > 0) process.stderr.write(`[choros] reaped ${killed} orphan inotifywait(s)\n`)
}
reapOrphanWatchers()

// --- Heartbeat: refresh every HEARTBEAT_INTERVAL_MS so peers can distinguish
// "MCP alive" from "MCP dead but inbox dir still present". Stale heartbeat
// (> LIVE_MAX_AGE_MS) means filesystem delivery still works but push
// notifications will silently fail. Senders surface this to the user.

/** v0.10 heartbeat is more than a liveness probe — it's the swarm-wide
 *  awareness substrate. Every peer can stat it for free. Carries:
 *   - pid, ts: legacy liveness
 *   - cwd: where this session is working
 *   - last_user_prompt: most recent user prompt (truncated, tail-scanned)
 *   - status: agent-set, "what am I currently doing"
 *   - intent: agent-set, "what am I trying to accomplish"
 *  Agent-set fields come from .agent_state, written by mcp__msg__set_status
 *  and mcp__msg__set_intent. last_user_prompt is auto-derived. cwd is free.
 */
const LAST_PROMPT_TAIL_BYTES = 256 * 1024
const LAST_PROMPT_MAX_CHARS = 240

async function readAgentState(): Promise<{ status?: string; status_set_at?: string; intent?: string; intent_set_at?: string }> {
  try {
    return JSON.parse(await readFile(AGENT_STATE_PATH, 'utf8'))
  } catch { return {} }
}

async function readSubscriptions(sessionId: string = ME): Promise<string[]> {
  try {
    const path = sessionId === ME
      ? SUBSCRIPTIONS_PATH
      : join(CHOROS_ROOT, sessionId, '.subscriptions')
    const data = JSON.parse(await readFile(path, 'utf8'))
    return Array.isArray(data?.topics) ? data.topics.filter((t: unknown) => typeof t === 'string') : []
  } catch { return [] }
}

async function writeSubscriptions(topics: string[]): Promise<void> {
  await atomicWrite(SUBSCRIPTIONS_PATH, JSON.stringify({ topics: Array.from(new Set(topics)).sort() }))
}

async function readLastUserPrompt(): Promise<string | undefined> {
  const jsonl = await findJsonlForSession(ME)
  if (!jsonl) return undefined
  try {
    const fileSize = (await stat(jsonl)).size
    const tailBytes = Math.min(fileSize, LAST_PROMPT_TAIL_BYTES)
    const fd = await open(jsonl, 'r')
    try {
      const buf = Buffer.alloc(tailBytes)
      await fd.read(buf, 0, tailBytes, Math.max(0, fileSize - tailBytes))
      const lines = buf.toString('utf8').split('\n')
      // Walk from the end to find the most recent user prompt that looks
      // like real text (skip tool_result / attachment blobs).
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        if (!line.includes('"type":"user"')) continue
        try {
          const ev = JSON.parse(line)
          const c = ev?.message?.content
          // user prompts can be a string or an array of {type:"text",text:""}.
          let text: string | undefined
          if (typeof c === 'string') text = c
          else if (Array.isArray(c)) {
            const textBlock = c.find((b: any) => b?.type === 'text' && typeof b.text === 'string')
            if (textBlock) text = textBlock.text
          }
          if (text && !text.startsWith('[')) {
            return text.slice(0, LAST_PROMPT_MAX_CHARS)
          }
        } catch { /* malformed line, keep walking */ }
      }
    } finally {
      await fd.close()
    }
  } catch { /* IO error, fall through to undefined */ }
  return undefined
}

async function writeHeartbeat() {
  try {
    const [agentState, lastPrompt] = await Promise.all([
      readAgentState(),
      readLastUserPrompt(),
    ])
    const payload: Record<string, unknown> = {
      pid: process.pid,
      ts: new Date().toISOString(),
      cwd: process.cwd(),
    }
    if (lastPrompt) payload.last_user_prompt = lastPrompt
    if (agentState.status) {
      payload.status = agentState.status
      payload.status_set_at = agentState.status_set_at
    }
    if (agentState.intent) {
      payload.intent = agentState.intent
      payload.intent_set_at = agentState.intent_set_at
    }
    await atomicWrite(HEARTBEAT_PATH, JSON.stringify(payload))
  } catch (e: any) {
    process.stderr.write(`[choros] heartbeat write failed: ${e?.message ?? e}\n`)
  }
}
await writeHeartbeat()
const heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS)
heartbeatTimer.unref?.()

type LivenessStatus = 'live' | 'wedged' | 'stale' | 'unknown'

interface RecipientHealth {
  status: LivenessStatus
  age_ms?: number
  /** Age in ms of recipient's JSONL last-modified mtime. Approximates "last
   *  agent turn." Heartbeat fresh + last_agent_turn stale = agent likely
   *  paused (AskUserQuestion, idle awaiting user, or wedged MCP-client).
   *  Sender uses both signals to set expectation. Undefined for non-UUID
   *  legacy dirs that have no JSONL. */
  last_agent_turn_age_ms?: number
  wedge_detected_at?: string
  wedge_pending_msg_ids?: string[]
}

/** Best-effort: stat the recipient's JSONL to approximate the last time
 *  their agent turn-loop wrote anything. Returns undefined for non-UUID
 *  recipients (legacy dirs have no JSONL to consult).
 */
async function recipientLastAgentTurnAgeMs(recipientId: string): Promise<number | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recipientId)) {
    return undefined
  }
  const jsonl = await findJsonlForSession(recipientId)
  if (!jsonl) return undefined
  try {
    const s = await stat(jsonl)
    return Date.now() - s.mtimeMs
  } catch {
    return undefined
  }
}

async function recipientLiveness(recipientId: string): Promise<RecipientHealth> {
  let heartbeatAgeMs: number | undefined
  let peerPid: number | undefined
  try {
    const s = await stat(join(CHOROS_ROOT, recipientId, '.heartbeat'))
    heartbeatAgeMs = Date.now() - s.mtimeMs
    try {
      const hb = JSON.parse(await readFile(join(CHOROS_ROOT, recipientId, '.heartbeat'), 'utf8'))
      if (typeof hb?.pid === 'number') peerPid = hb.pid
    } catch { /* malformed heartbeat — fall through, pidAlive(undefined) returns false */ }
  } catch {
    // ENOENT: never heartbeated. MCP never loaded in that session, or
    // session has not yet started.
    return { status: 'unknown' }
  }

  const lastAgentTurnAgeMs = await recipientLastAgentTurnAgeMs(recipientId)

  // Fresh heartbeat but the bun is gone: a clean exit drops /proc/<pid>
  // immediately while .heartbeat mtime stays frozen at last-tick. Surface
  // as 'stale' so the send response carries the same honest "won't push
  // eagerly" framing as a stale-by-age heartbeat.
  if (heartbeatAgeMs <= LIVE_MAX_AGE_MS && !(await pidAlive(peerPid))) {
    return { status: 'stale', age_ms: heartbeatAgeMs, last_agent_turn_age_ms: lastAgentTurnAgeMs }
  }

  // If the recipient bun is alive but it has declared itself wedged (≥
  // WEDGE_TIMEOUT_THRESHOLD consecutive push timeouts), the push will go
  // straight to a hung mcp.notification on the recipient side. Sender should
  // know NOT to expect an eager response even though heartbeat is fresh.
  if (heartbeatAgeMs <= LIVE_MAX_AGE_MS) {
    try {
      const wedgeStr = await readFile(join(CHOROS_ROOT, recipientId, '.wedged'), 'utf8')
      const wedge = JSON.parse(wedgeStr) as { detected_at?: string; pending_msg_ids?: string[] }
      return {
        status: 'wedged',
        age_ms: heartbeatAgeMs,
        last_agent_turn_age_ms: lastAgentTurnAgeMs,
        wedge_detected_at: wedge.detected_at,
        wedge_pending_msg_ids: wedge.pending_msg_ids,
      }
    } catch { /* no marker = not wedged */ }
    return { status: 'live', age_ms: heartbeatAgeMs, last_agent_turn_age_ms: lastAgentTurnAgeMs }
  }
  return { status: 'stale', age_ms: heartbeatAgeMs, last_agent_turn_age_ms: lastAgentTurnAgeMs }
}

function fmtAge(ageMs?: number): string {
  if (ageMs === undefined) return 'unknown'
  const s = Math.floor(ageMs / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

/** Describes recipient state and how to verify end-to-end delivery.
 *  Three signals: bun-heartbeat (alive?), recipient JSONL mtime (agent
 *  actively turning?), and verify_path (where `.seen` will land once the
 *  recipient bun's JSONL-probe confirms CC recorded the push). Sender
 *  reasons from the raw description; no prescribed actions.
 */
function livenessTag(live: RecipientHealth, verifyPath: string): string {
  const hb = fmtAge(live.age_ms)
  const turnAge = fmtAge(live.last_agent_turn_age_ms)
  const verify = `Verify delivery: stat ${verifyPath} after ~10s. Present = JSONL-confirmed; absent = recipient bun did not confirm.`

  switch (live.status) {
    case 'live': {
      const turnStale = live.last_agent_turn_age_ms !== undefined
        && live.last_agent_turn_age_ms > LIVE_MAX_AGE_MS
      if (turnStale) {
        return `Recipient MCP heartbeat ${hb} (alive), but last agent turn ${turnAge} — recipient agent hasn't taken a tool-loop turn lately. Could be idle, blocked on a long action, or pushes are dropping silently. Eager delivery not assured. ${verify}`
      }
      return `Recipient MCP live (heartbeat ${hb}, last agent turn ${turnAge}). Push fired. ${verify}`
    }
    case 'wedged':
      return `Recipient MCP wedged: heartbeat ${hb} but push channel has timed out ≥${WEDGE_TIMEOUT_THRESHOLD} times (since ${live.wedge_detected_at ?? 'recently'}). Filesystem delivery succeeded; the recipient bun's push to Claude Code is not landing. ${verify}`
    case 'stale':
      return `Recipient MCP heartbeat ${hb} (alive threshold ${LIVE_MAX_AGE_MS / 1000}s) — server likely dead. Filesystem delivery succeeded; no live bun to push. ${verify}`
    case 'unknown':
      return `Recipient has no heartbeat file — MCP never loaded in this session. Filesystem delivery succeeded; no push will fire.`
  }
}

// --- MCP server ---

const mcp = new Server(
  { name: 'choros', version: '0.17.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions:
      `Inter-session messaging between Claude Code sessions on this machine.\n` +
      `\n` +
      `Your session id is ${ME}. Your display name comes from your /rename or auto ai-title (read live from your session JSONL).\n` +
      `\n` +
      `Inbound messages arrive as <channel source="choros" from_name="..." from_session="..." msg_id="..." ts="..." reply_budget="..." in_reply_to="...">. from_name is the routing handle the user typically references; from_session is the stable UUID.\n` +
      `\n` +
      `Delivery acks for your outbound messages arrive as <channel source="choros-ack" msg_id="..." status="delivered|dropped" to_name="..." verified_at="...">. status="delivered" means the recipient bun's JSONL-probe confirmed CC recorded the push. status="dropped" means it did not.\n` +
      `\n` +
      `Presence events arrive as <channel source="choros-presence" event="join|leave|roster" peer_id="..." peer_name="..." ...>. join/leave fire when another session boots or shuts down; roster fires once at your own boot to list peers already online. Lets the swarm self-discover without explicit registration.\n` +
      `\n` +
      `To send, call the send tool with to=<display name OR session-id OR session-id prefix> and body=<text>. Names resolve via /rename; collisions resolve to most-recently-active. The response carries: recipient heartbeat age, recipient last-agent-turn age, and a verify_path you can stat after ~10s for a one-step delivery check (present = JSONL-confirmed; absent = recipient bun did not confirm). Heartbeat fresh + agent-turn stale = recipient agent hasn't turned recently; do not assume eager delivery.\n` +
      `\n` +
      `For system-wide diagnosis, call the doctor tool — returns structured JSON: this session's health, every known peer's classification (live, paused, wedged, stale, dead, none), and outbound msgs lacking confirmed .seen.\n` +
      `\n` +
      `Set your ambient state for the swarm to see: set_status text:"what I'm currently doing" and set_intent text:"the bigger goal". Both are persisted to your heartbeat payload (cwd is added automatically). Doctor surfaces these for every peer. Update at significant transitions so the swarm has continuous awareness without explicit messaging.\n` +
      `\n` +
      `Topic channels (pub/sub): subscribe topic:"deploy-room" to receive every publish to that topic; unsubscribe topic:"deploy-room" to stop; publish topic:"deploy-room" body:"..." to fan out to every subscriber. Topic messages arrive as standard <channel source="choros"> events with an extra topic meta field. Topics are free-form; no central registry. Use for swarm-wide chatter where you don't want to address peers individually.\n` +
      `\n` +
      `React to a message with react msg_id:"..." emoji:"👍". The original sender's agent gets a <channel source="choros-reaction"> event. Use when a full reply is overkill — thumbs-up, acknowledge, quick takes.\n` +
      `\n` +
      `Broadcast: broadcast body:"..." fans the message to every live peer in one call. Recipients see a standard <channel source="choros" broadcast="true" ...> event. Noisy — only call when the swarm benefits from knowing. Prefer publish to a topic if the audience is narrower.\n` +
      `\n` +
      `@-mentions: any @<name-or-uuid-prefix> token inside a body (send / broadcast / publish) gets resolved to peer IDs and surfaced on the recipient side. If you're in the resolved list, the channel event carries mentioned_me="true" — route attention accordingly. The full mentions list lands in the meta as comma-separated peer IDs.\n` +
      `\n` +
      `Read receipts: when you /choros read a message (archive it into inbox/read/), the original sender's agent receives a <channel source="choros-read" msg_id by_name read_at> event. Distinct from choros-ack (which is delivery — the channel event was injected into your CC log). choros-read is engagement — you actually processed the message. Replies and reactions are stronger signals of engagement and have their own channel events.\n` +
      `\n` +
      `Poll-on-resume: when idle (post-tool-result, post-user-input), check /choros inbox if you have reason to expect a message. Push is best-effort; the filesystem is the source of truth.\n` +
      `\n` +
      `Reply convention: pass in_reply_to=<msg_id of inbound> for threading. reply_budget=N permits N-1 further replies (recipient picks strictly less). budget=0 is terminal — absence of reply is intentional, not a delivery failure. Default to replying when the inbound is conversational; surface to human when terminal or when looping without convergence.`,
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send',
      description:
        'Send a message to another Claude Code session on this machine. Recipient receives a <channel> push event without typing. ' +
        'Returns the message id and resolved recipient.',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Recipient display name (their /rename value), session UUID, or unambiguous UUID prefix. If unknown, creates a new inbox dir under that literal name.',
          },
          body: {
            type: 'string',
            description: `Message body, free-form text. Max ${BODY_CAP_BYTES} bytes.`,
          },
          reply_budget: {
            type: 'integer',
            description: 'Optional. Max reply depth recipient may use. Recipient picks strictly smaller value or 0 to terminate.',
            minimum: 0,
          },
          in_reply_to: {
            type: 'string',
            description: 'Optional. msg_id of the message this is replying to. Enables thread walking.',
          },
        },
        required: ['to', 'body'],
      },
    },
    {
      name: 'doctor',
      description:
        'Diagnostic snapshot of the choros system. Returns structured JSON: this session\'s health (heartbeat, wedge state, inbox stats), every known peer\'s health (heartbeat age, last agent turn age, wedge state, classification), and outbound messages this session has not yet had confirmed delivery for. ' +
        'Optional filters narrow the report. Use when sends look like they may have been dropped, when /choros inbox shows unread items without [delivered], or when an agent-to-agent flow is silent. Raw data — no pre-computed verdicts; the calling agent reasons over the fields.',
      inputSchema: {
        type: 'object',
        properties: {
          peer: {
            type: 'string',
            description: 'Optional. Limit the peers array to a single recipient matched by display name, UUID, or UUID prefix. Same resolver as send. Default: include all known peers.',
          },
          msg_id: {
            type: 'string',
            description: 'Optional. Trace one specific msg_id across both inbox and sent — reports its presence in this session\'s inbox/sent, whether .seen is written, and where on disk to find it. Default: all unread inbox + all unconfirmed sent.',
          },
        },
        required: [],
      },
    },
    {
      name: 'set_status',
      description:
        'Set this session\'s ambient status — what you\'re currently doing. Appears in your .heartbeat payload and surfaces to every peer via doctor. Call at significant transitions ("starting OODA loop on PR #840", "blocked on review", "idle awaiting user"). Persists across heartbeat ticks until updated. Pass empty text to clear.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Short human-readable status (≤200 chars). Empty string clears.',
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'set_intent',
      description:
        'Set this session\'s ambient intent — what you\'re trying to accomplish at a higher level than status. Appears in your .heartbeat payload and surfaces to every peer via doctor. Call once at session start with the bigger goal; update on direction changes. Pass empty text to clear.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Short human-readable intent (≤200 chars). Empty string clears.',
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'subscribe',
      description:
        'Subscribe this session to a topic. Future publishes to that topic land in your inbox as regular channel events with a topic meta field. Topics are free-form strings (e.g. "deploy-room", "ci-failures", "design-decisions"). Subscriptions persist across heartbeat ticks. Each call adds one topic to the set.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Topic name to subscribe to.' },
        },
        required: ['topic'],
      },
    },
    {
      name: 'unsubscribe',
      description:
        'Remove a topic from this session\'s subscriptions. Future publishes to that topic will not reach you.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Topic name to unsubscribe from.' },
        },
        required: ['topic'],
      },
    },
    {
      name: 'publish',
      description:
        'Publish a message to a topic. Bun reads every peer\'s subscription set and writes an inbox file to each subscriber. Recipients receive a regular <channel source="choros" topic="..." ...> event. Returns the list of peers the message was delivered to (filesystem-level — same JSONL-confirmed semantics as send). Use for swarm-wide announcements where you don\'t want to address peers individually.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Topic to publish to.' },
          body: { type: 'string', description: `Message body. Max ${BODY_CAP_BYTES} bytes.` },
          reply_budget: {
            type: 'integer',
            description: 'Optional. Max reply depth per recipient.',
            minimum: 0,
          },
        },
        required: ['topic', 'body'],
      },
    },
    {
      name: 'broadcast',
      description:
        'Send a message to every live peer in one call. Recipients receive a regular <channel source="choros" broadcast="true" ...> event. Use when something is relevant to the whole swarm and there is no natural topic. NOISY — every live peer pays the context cost. Prefer publish to a topic if the audience is narrower than "everyone alive right now." Returns the list of recipients.',
      inputSchema: {
        type: 'object',
        properties: {
          body: { type: 'string', description: `Message body. Max ${BODY_CAP_BYTES} bytes.` },
          reply_budget: {
            type: 'integer',
            description: 'Optional. Max reply depth per recipient.',
            minimum: 0,
          },
        },
        required: ['body'],
      },
    },
    {
      name: 'react',
      description:
        'React to a message you received with a short emoji or text reaction. Lighter weight than a full reply. The original sender gets a <channel source="choros-reaction"> event surfacing your reaction. Use for thumbs-up / acknowledge / quick takes that don\'t deserve a full reply. msg_id is the id of the message you\'re reacting to (from your inbox).',
      inputSchema: {
        type: 'object',
        properties: {
          msg_id: { type: 'string', description: 'The msg_id you are reacting to (must be in your inbox or read archive).' },
          emoji: { type: 'string', description: 'Short reaction — emoji, single word, or short phrase (≤32 chars).' },
        },
        required: ['msg_id', 'emoji'],
      },
    },
  ],
}))

interface DoctorPeer {
  id: string
  name: string | null
  is_uuid: boolean
  heartbeat_age_ms: number | undefined
  heartbeat_ts: string | undefined
  /** v0.10+: peer's working directory from their heartbeat payload. */
  cwd: string | undefined
  /** v0.10+: agent-set status from their heartbeat payload. */
  status: string | undefined
  status_set_at: string | undefined
  /** v0.10+: agent-set intent from their heartbeat payload. */
  intent: string | undefined
  intent_set_at: string | undefined
  /** v0.10+: most recent user prompt as captured by peer's bun (truncated). */
  last_user_prompt: string | undefined
  last_agent_turn_age_ms: number | undefined
  wedged: boolean
  wedge_detected_at: string | undefined
  wedge_pending_msg_ids: string[] | undefined
  classification: 'live' | 'paused' | 'wedged' | 'stale' | 'dead' | 'none'
  inbox_unread: number
  /** Msgs I sent this peer that don't have a confirmed .seen yet. */
  outbound_unconfirmed: Array<{
    msg_id: string
    sent_ts: string
    age_ms: number
    verify_path: string
  }>
}

interface DoctorMsgTrace {
  msg_id: string
  local_inbox_present: boolean
  local_inbox_seen: boolean
  local_sent_present: boolean
  local_inbox_path: string | null
  local_sent_path: string | null
  // Body excerpt for orientation; truncated to keep response small.
  body_preview: string | null
  from_session: string | null
  to_session: string | null
  ts: string | null
}

async function classifyPeerHeartbeat(
  hb: number | undefined,
  hasWedge: boolean,
  agentTurnAge: number | undefined,
  bunAlive: boolean,
): Promise<DoctorPeer['classification']> {
  if (hb === undefined) return 'none'
  if (hb > 600_000) return 'dead'
  // Fresh heartbeat but no live bun = the writer exited cleanly seconds ago.
  // Mtime hasn't aged out yet but the peer is gone. Classify as dead so
  // sender-side decisions (fan-out, presence) reflect reality.
  if (!bunAlive) return 'dead'
  if (hb > LIVE_MAX_AGE_MS) return 'stale'
  if (hasWedge) return 'wedged'
  if (agentTurnAge !== undefined && agentTurnAge > LIVE_MAX_AGE_MS) return 'paused'
  return 'live'
}

async function probePeer(id: string, isUuid: boolean, name: string | null): Promise<DoctorPeer> {
  const dir = join(CHOROS_ROOT, id)
  let heartbeatAgeMs: number | undefined
  let heartbeatTs: string | undefined
  let cwd: string | undefined
  let status: string | undefined
  let status_set_at: string | undefined
  let intent: string | undefined
  let intent_set_at: string | undefined
  let last_user_prompt: string | undefined
  let peerPid: number | undefined
  try {
    const s = await stat(join(dir, '.heartbeat'))
    heartbeatAgeMs = Date.now() - s.mtimeMs
    heartbeatTs = new Date(s.mtimeMs).toISOString()
    try {
      const hb = JSON.parse(await readFile(join(dir, '.heartbeat'), 'utf8'))
      if (typeof hb.pid === 'number') peerPid = hb.pid
      if (typeof hb.cwd === 'string') cwd = hb.cwd
      if (typeof hb.status === 'string') status = hb.status
      if (typeof hb.status_set_at === 'string') status_set_at = hb.status_set_at
      if (typeof hb.intent === 'string') intent = hb.intent
      if (typeof hb.intent_set_at === 'string') intent_set_at = hb.intent_set_at
      if (typeof hb.last_user_prompt === 'string') last_user_prompt = hb.last_user_prompt
    } catch { /* malformed heartbeat — skip */ }
  } catch { /* no heartbeat */ }

  let wedged = false
  let wedge_detected_at: string | undefined
  let wedge_pending_msg_ids: string[] | undefined
  try {
    const raw = await readFile(join(dir, '.wedged'), 'utf8')
    const parsed = JSON.parse(raw) as { detected_at?: string; pending_msg_ids?: string[] }
    wedged = true
    wedge_detected_at = parsed.detected_at
    wedge_pending_msg_ids = parsed.pending_msg_ids
  } catch { /* no wedge */ }

  const last_agent_turn_age_ms = await recipientLastAgentTurnAgeMs(id)

  const bunAlive = await pidAlive(peerPid)
  const classification = await classifyPeerHeartbeat(heartbeatAgeMs, wedged, last_agent_turn_age_ms, bunAlive)

  // Count peer's unread inbox — informational; useful when debugging a
  // peer that's accumulating un-pushed messages.
  const peerInbox = join(dir, 'inbox')
  const inboxFiles = await readdir(peerInbox).catch(() => [])
  const inbox_unread = inboxFiles.filter(
    f => f.endsWith('.json') && !f.startsWith('.') && !f.endsWith('.seen'),
  ).length

  // Outbound unconfirmed: any msg I sent this peer (lives in MY_SENT) that
  // has no .seen sidecar in their inbox.
  const outbound_unconfirmed: DoctorPeer['outbound_unconfirmed'] = []
  const sentFiles = await readdir(MY_SENT).catch(() => [])
  for (const f of sentFiles) {
    if (!f.endsWith('.json')) continue
    let payload: any
    try { payload = JSON.parse(await readFile(join(MY_SENT, f), 'utf8')) } catch { continue }
    if (payload?.to_session !== id) continue
    const verify_path = join(peerInbox, `${payload.id}.json.seen`)
    if (existsSync(verify_path)) continue
    let ageMs = 0
    try { ageMs = Date.now() - new Date(payload.ts).getTime() } catch {}
    outbound_unconfirmed.push({
      msg_id: payload.id,
      sent_ts: payload.ts,
      age_ms: ageMs,
      verify_path,
    })
  }

  return {
    id,
    name,
    is_uuid: isUuid,
    heartbeat_age_ms: heartbeatAgeMs,
    heartbeat_ts: heartbeatTs,
    cwd,
    status,
    status_set_at,
    intent,
    intent_set_at,
    last_user_prompt,
    last_agent_turn_age_ms,
    wedged,
    wedge_detected_at,
    wedge_pending_msg_ids,
    classification,
    inbox_unread,
    outbound_unconfirmed,
  }
}

async function traceMsgId(msgId: string): Promise<DoctorMsgTrace> {
  const trace: DoctorMsgTrace = {
    msg_id: msgId,
    local_inbox_present: false,
    local_inbox_seen: false,
    local_sent_present: false,
    local_inbox_path: null,
    local_sent_path: null,
    body_preview: null,
    from_session: null,
    to_session: null,
    ts: null,
  }
  const inboxPath = join(MY_INBOX, `${msgId}.json`)
  if (existsSync(inboxPath)) {
    trace.local_inbox_present = true
    trace.local_inbox_path = inboxPath
    trace.local_inbox_seen = existsSync(`${inboxPath}.seen`)
    try {
      const p = JSON.parse(await readFile(inboxPath, 'utf8'))
      trace.from_session = p.from_session ?? p.from ?? null
      trace.to_session = p.to_session ?? null
      trace.ts = p.ts ?? null
      trace.body_preview = typeof p.body === 'string' ? p.body.slice(0, 200) : null
    } catch {}
  }
  const sentPath = join(MY_SENT, `${msgId}.json`)
  if (existsSync(sentPath)) {
    trace.local_sent_present = true
    trace.local_sent_path = sentPath
    try {
      const p = JSON.parse(await readFile(sentPath, 'utf8'))
      trace.from_session = trace.from_session ?? p.from_session ?? null
      trace.to_session = trace.to_session ?? p.to_session ?? null
      trace.ts = trace.ts ?? p.ts ?? null
      trace.body_preview = trace.body_preview ?? (typeof p.body === 'string' ? p.body.slice(0, 200) : null)
    } catch {}
  }
  return trace
}

async function handleDoctorRequest(rawArgs: Record<string, unknown>) {
  const args = rawArgs as { peer?: string; msg_id?: string }
  const peerFilter = typeof args.peer === 'string' ? args.peer.trim() : ''
  const msgIdFilter = typeof args.msg_id === 'string' ? args.msg_id.trim() : ''

  // Build self report
  const myName = await resolveMyName()
  const myInboxFiles = await readdir(MY_INBOX).catch(() => [])
  const myInboxUnread = myInboxFiles.filter(
    f => f.endsWith('.json') && !f.startsWith('.') && !f.endsWith('.seen'),
  )
  const myInboxUnreadUnconfirmed = myInboxUnread.filter(
    f => !existsSync(join(MY_INBOX, `${f}.seen`)),
  )
  const myWedged = existsSync(WEDGE_PATH)

  const self = {
    session_id: ME,
    display_name: myName,
    version: '0.17.0',
    pid: process.pid,
    heartbeat_path: HEARTBEAT_PATH,
    inbox_path: MY_INBOX,
    sent_path: MY_SENT,
    wedge_path: WEDGE_PATH,
    wedged: myWedged,
    consecutive_timeouts: consecutiveTimeouts,
    inbox_unread: myInboxUnread.length,
    /** Unread inbox files without a .seen sidecar — push not yet
     *  confirmed by JSONL probe. Will retry on next sweep tick. */
    inbox_unread_unconfirmed: myInboxUnreadUnconfirmed.length,
    inbox_unread_files: myInboxUnread,
  }

  // If msg_id filter set, focus on that trace (still include self/peer state).
  let msg_trace: DoctorMsgTrace | undefined
  if (msgIdFilter) {
    msg_trace = await traceMsgId(msgIdFilter)
  }

  // Enumerate peers. Self-exclusion mirrors broadcastPresence: by UUID, by
  // display name, by heartbeat PID. Doctor and presence must agree on
  // "who is me" so neither lies in the roster vs in the diagnostic.
  const known = await listKnownInstances()
  const peers: DoctorPeer[] = []
  for (const k of known) {
    if (k.id === ME) continue
    if (k.name && k.name === myName) continue
    try {
      const hb = await readFile(join(CHOROS_ROOT, k.id, '.heartbeat'), 'utf8')
      try {
        const hbData = JSON.parse(hb)
        if (hbData?.pid === process.pid) continue
      } catch { /* unparseable — fall through */ }
    } catch { /* no heartbeat — keep peer */ }
    if (peerFilter) {
      const matches =
        k.id === peerFilter
        || k.name === peerFilter
        || (k.isUuid && k.id.startsWith(peerFilter))
      if (!matches) continue
    }
    peers.push(await probePeer(k.id, k.isUuid, k.name))
  }

  const report = { self, peers, ...(msg_trace ? { msg_trace } : {}) }
  return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] }
}

const AGENT_STATE_MAX_CHARS = 200

async function handleSetAgentState(tool: 'set_status' | 'set_intent', rawArgs: Record<string, unknown>) {
  const args = rawArgs as { text?: string }
  const text = (args.text ?? '').toString().slice(0, AGENT_STATE_MAX_CHARS)
  const key = tool === 'set_status' ? 'status' : 'intent'
  const setKey = `${key}_set_at`
  const now = new Date().toISOString()

  const current = await readAgentState()
  if (text) {
    ;(current as any)[key] = text
    ;(current as any)[setKey] = now
  } else {
    delete (current as any)[key]
    delete (current as any)[setKey]
  }
  try {
    await atomicWrite(AGENT_STATE_PATH, JSON.stringify(current))
  } catch (e: any) {
    throw new Error(`failed to persist agent state: ${e?.message ?? e}`)
  }
  // Force the heartbeat to refresh immediately so the new state is visible
  // to peers without waiting for the next 30s tick.
  await writeHeartbeat()
  return {
    content: [{
      type: 'text',
      text: text
        ? `${key} set to: ${text}`
        : `${key} cleared`,
    }],
  }
}

async function handleSubscribe(rawArgs: Record<string, unknown>) {
  const args = rawArgs as { topic?: string }
  const topic = (args.topic ?? '').toString().trim()
  if (!topic) throw new Error('subscribe: "topic" is required')
  const current = await readSubscriptions()
  if (current.includes(topic)) {
    return { content: [{ type: 'text', text: `already subscribed to ${topic}` }] }
  }
  await writeSubscriptions([...current, topic])
  return { content: [{ type: 'text', text: `subscribed to ${topic}` }] }
}

async function handleUnsubscribe(rawArgs: Record<string, unknown>) {
  const args = rawArgs as { topic?: string }
  const topic = (args.topic ?? '').toString().trim()
  if (!topic) throw new Error('unsubscribe: "topic" is required')
  const current = await readSubscriptions()
  if (!current.includes(topic)) {
    return { content: [{ type: 'text', text: `not subscribed to ${topic}` }] }
  }
  await writeSubscriptions(current.filter(t => t !== topic))
  return { content: [{ type: 'text', text: `unsubscribed from ${topic}` }] }
}

/** Scan a body for @<handle> mentions and resolve each to a peer session id.
 *  Returns the deduped set of resolved peer IDs. Unresolved @-handles are
 *  silently ignored — keeps body authoring forgiving.
 *
 *  Mention syntax: `@` followed by [A-Za-z0-9._-]+. Matches across the body,
 *  including inside words at start-of-string or after whitespace/punctuation.
 *  Avoids matching email addresses by requiring the `@` to be either at
 *  start-of-body or preceded by whitespace / a few common punctuation chars.
 */
async function parseMentions(body: string): Promise<string[]> {
  const re = /(?:^|[\s(,;:!?])@([A-Za-z0-9._-]+)/g
  const handles = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    handles.add(m[1])
  }
  if (handles.size === 0) return []
  // Resolve only to KNOWN peers — skip the fall-through that would create a
  // new dir under an arbitrary @-handle (typo, hallucinated name). The pre-
  // resolution list bypasses resolveRecipient's fall-through.
  const known = await listKnownInstances()
  const myName = await resolveMyName()
  const mentioned = new Set<string>()
  for (const handle of handles) {
    // Self-mention filter: skip @me, @<my-display-name>, @<my-uuid-prefix>.
    if (handle === ME || handle === myName || (ME.startsWith(handle) && handle.length >= 8)) continue
    const matchUuid = known.find(k => k.isUuid && k.id === handle)
    if (matchUuid) { mentioned.add(matchUuid.id); continue }
    const matchName = known.find(k => k.name === handle)
    if (matchName) { mentioned.add(matchName.id); continue }
    const prefix = known.filter(k => k.isUuid && k.id.startsWith(handle))
    if (prefix.length === 1) { mentioned.add(prefix[0].id); continue }
    // Unresolved handle — silently ignored.
  }
  return Array.from(mentioned)
}

async function handleBroadcast(rawArgs: Record<string, unknown>) {
  const args = rawArgs as { body?: string; reply_budget?: number }
  const body = args.body ?? ''
  if (!body) throw new Error('broadcast: "body" is required')
  if (Buffer.byteLength(body, 'utf8') > BODY_CAP_BYTES) {
    throw new Error(`broadcast: body exceeds ${BODY_CAP_BYTES} bytes`)
  }

  const fromName = await resolveMyName()
  const known = await listKnownInstances()

  // Live peers, with the same three-layer self-exclusion as broadcastPresence.
  const myName = await resolveMyName()
  const recipients: { id: string; name: string | null }[] = []
  for (const k of known) {
    if (k.id === ME) continue
    if (k.name && k.name === myName) continue
    try {
      const hb = await readFile(join(CHOROS_ROOT, k.id, '.heartbeat'), 'utf8')
      try {
        const hbData = JSON.parse(hb)
        if (hbData?.pid === process.pid) continue
      } catch { /* unparseable — fall through */ }
    } catch { /* no heartbeat */ }
    if (await isLivePeer(k.id)) recipients.push({ id: k.id, name: k.name })
  }

  const mentions = await parseMentions(body)
  const isoNow = new Date().toISOString()
  const ts = isoNow.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const id = `${ts}-${ME.slice(0, 8)}`
  const delivered: string[] = []
  for (const r of recipients) {
    const payload: Record<string, unknown> = {
      id,
      broadcast: true,
      from_session: ME,
      from_name: fromName,
      from_cwd: process.cwd(),
      from_host: hostname(),
      to_session: r.id,
      to_name: r.name,
      body,
      ts: isoNow,
    }
    if (mentions.length > 0) payload.mentions = mentions
    if (typeof args.reply_budget === 'number' && args.reply_budget >= 0) {
      payload.reply_budget = Math.floor(args.reply_budget)
    }
    const json = JSON.stringify(payload, null, 2)
    await writeFile(join(MY_SENT, `${id}.${r.id.slice(0, 8)}.json`), json)
    const recipInbox = join(CHOROS_ROOT, r.id, 'inbox')
    await mkdir(recipInbox, { recursive: true })
    const finalPath = join(recipInbox, `${id}.json`)
    const tmpPath = join(recipInbox, `.${id}.tmp`)
    await writeFile(tmpPath, json)
    await rename(tmpPath, finalPath)
    delivered.push(r.name ?? r.id.slice(0, 8))
  }

  const mentionsNote = mentions.length > 0
    ? ` (mentions: ${mentions.length})`
    : ''
  const summary = recipients.length === 0
    ? 'broadcast — 0 live peers'
    : `broadcast (id=${id}) — delivered to ${recipients.length} live peer(s): ${delivered.join(', ')}${mentionsNote}`
  return { content: [{ type: 'text', text: summary }] }
}

async function handleReact(rawArgs: Record<string, unknown>) {
  const args = rawArgs as { msg_id?: string; emoji?: string }
  const msgId = (args.msg_id ?? '').toString().trim()
  const emoji = (args.emoji ?? '').toString().trim().slice(0, 32)
  if (!msgId) throw new Error('react: "msg_id" is required')
  if (!emoji) throw new Error('react: "emoji" is required')
  sanitizeId(msgId, 'react.msg_id')

  // Look up the original sender's session id by reading the inbox file.
  // Check live inbox first, then read/ archive.
  const candidates = [
    join(MY_INBOX, `${msgId}.json`),
    join(MY_READ, `${msgId}.json`),
  ]
  let fromSession: string | undefined
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const payload = JSON.parse(await readFile(path, 'utf8'))
      fromSession = typeof payload.from_session === 'string' ? payload.from_session : undefined
      break
    } catch { /* keep trying */ }
  }
  if (!fromSession) {
    throw new Error(`react: msg_id=${msgId} not found in inbox or read archive`)
  }
  sanitizeId(fromSession, 'react.from_session (from msg payload)')

  // Refuse self-reactions; the original sender is us, the channel event
  // would loop. (parseMentions, broadcast, doctor all use the same check.)
  if (await isSelf(fromSession, null)) {
    throw new Error('react: cannot react to your own message')
  }

  const myName = await resolveMyName()
  const senderAcksDir = join(CHOROS_ROOT, fromSession, 'sent_acks')
  await mkdir(senderAcksDir, { recursive: true })
  // Sanitize the emoji once more — sliced above, but could still contain
  // path separators / NUL. Replace unsafe chars with a marker so the file
  // is still distinguishable but path-safe.
  const safeEmoji = emoji.replace(/[\x00-\x1f\x7f/\\]/g, '_')
  const reactionFileName = `${msgId}.${ME.slice(0, 8)}.${Date.now()}.react`
  const reactionPath = join(senderAcksDir, reactionFileName)
  const tmpPath = join(senderAcksDir, `.${reactionFileName}.tmp`)
  const payload = JSON.stringify({
    msg_id: msgId,
    emoji: safeEmoji,
    from_session: ME,
    from_name: myName,
    ts: new Date().toISOString(),
  })
  await writeFile(tmpPath, payload)
  await rename(tmpPath, reactionPath)

  return { content: [{ type: 'text', text: `reacted ${emoji} to ${msgId}` }] }
}

async function handlePublish(rawArgs: Record<string, unknown>) {
  const args = rawArgs as { topic?: string; body?: string; reply_budget?: number }
  const topic = (args.topic ?? '').toString().trim()
  const body = args.body ?? ''
  if (!topic) throw new Error('publish: "topic" is required')
  if (!body) throw new Error('publish: "body" is required')
  if (Buffer.byteLength(body, 'utf8') > BODY_CAP_BYTES) {
    throw new Error(`publish: body exceeds ${BODY_CAP_BYTES} bytes`)
  }

  const fromName = await resolveMyName()
  const known = await listKnownInstances()

  // Find subscribers (peers with this topic in their .subscriptions). Skip
  // self — publish-to-own-topic is a no-op, not a self-loop.
  const subscribers: { id: string; name: string | null }[] = []
  for (const k of known) {
    if (k.id === ME) continue
    const topics = await readSubscriptions(k.id)
    if (topics.includes(topic)) subscribers.push({ id: k.id, name: k.name })
  }

  // Write inbox file to each subscriber. msg_id is shared per-publish so
  // recipients can dedupe across topics if needed.
  const mentions = await parseMentions(body)
  const isoNow = new Date().toISOString()
  const ts = isoNow.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const id = `${ts}-${ME.slice(0, 8)}`
  const delivered: { name: string; id: string }[] = []
  for (const sub of subscribers) {
    const payload: Record<string, unknown> = {
      id,
      topic,
      from_session: ME,
      from_name: fromName,
      from_cwd: process.cwd(),
      from_host: hostname(),
      to_session: sub.id,
      to_name: sub.name,
      body,
      ts: isoNow,
    }
    if (mentions.length > 0) payload.mentions = mentions
    if (typeof args.reply_budget === 'number' && args.reply_budget >= 0) {
      payload.reply_budget = Math.floor(args.reply_budget)
    }
    const json = JSON.stringify(payload, null, 2)
    await writeFile(join(MY_SENT, `${id}.${sub.id.slice(0, 8)}.json`), json)

    const subInbox = join(CHOROS_ROOT, sub.id, 'inbox')
    await mkdir(subInbox, { recursive: true })
    const finalPath = join(subInbox, `${id}.json`)
    const tmpPath = join(subInbox, `.${id}.tmp`)
    await writeFile(tmpPath, json)
    await rename(tmpPath, finalPath)
    delivered.push({ name: sub.name ?? sub.id.slice(0, 8), id: sub.id })
  }

  const summary = delivered.length === 0
    ? `published to topic ${topic} — 0 subscribers`
    : `published to topic ${topic} (id=${id}) — delivered to ${delivered.length} subscriber(s): ${delivered.map(d => d.name).join(', ')}`
  return { content: [{ type: 'text', text: summary }] }
}

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name === 'doctor') {
    return handleDoctorRequest(req.params.arguments ?? {})
  }
  if (req.params.name === 'set_status' || req.params.name === 'set_intent') {
    return handleSetAgentState(req.params.name, req.params.arguments ?? {})
  }
  if (req.params.name === 'subscribe') {
    return handleSubscribe(req.params.arguments ?? {})
  }
  if (req.params.name === 'unsubscribe') {
    return handleUnsubscribe(req.params.arguments ?? {})
  }
  if (req.params.name === 'publish') {
    return handlePublish(req.params.arguments ?? {})
  }
  if (req.params.name === 'react') {
    return handleReact(req.params.arguments ?? {})
  }
  if (req.params.name === 'broadcast') {
    return handleBroadcast(req.params.arguments ?? {})
  }
  if (req.params.name !== 'send') throw new Error(`unknown tool: ${req.params.name}`)

  const args = (req.params.arguments ?? {}) as {
    to?: string
    body?: string
    reply_budget?: number
    in_reply_to?: string
  }
  const toArg = (args.to ?? '').trim()
  const body = args.body ?? ''
  if (!toArg) throw new Error('send: "to" is required')
  if (!body) throw new Error('send: "body" is required')
  if (Buffer.byteLength(body, 'utf8') > BODY_CAP_BYTES) {
    throw new Error(
      `send: body exceeds ${BODY_CAP_BYTES} bytes (got ${Buffer.byteLength(body, 'utf8')}). Blob overflow not yet implemented; split or trim.`,
    )
  }

  const recipient = await resolveRecipient(toArg)
  if (await isSelf(recipient.id, recipient.name)) {
    throw new Error('send: cannot send to self (resolved recipient matches this session)')
  }
  const fromName = await resolveMyName()
  const mentions = await parseMentions(body)

  const isoNow = new Date().toISOString()
  const ts = isoNow.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const id = `${ts}-${ME.slice(0, 8)}`
  const msg: Record<string, unknown> = {
    id,
    from_session: ME,
    from_name: fromName,
    from_cwd: process.cwd(),
    from_host: hostname(),
    to_session: recipient.id,
    to_name: recipient.name,
    body,
    ts: isoNow,
  }
  if (mentions.length > 0) msg.mentions = mentions
  if (typeof args.reply_budget === 'number' && args.reply_budget >= 0) {
    msg.reply_budget = Math.floor(args.reply_budget)
  }
  if (typeof args.in_reply_to === 'string' && args.in_reply_to.trim()) {
    msg.in_reply_to = args.in_reply_to.trim()
  }

  const payload = JSON.stringify(msg, null, 2)
  await writeFile(join(MY_SENT, `${id}.json`), payload)

  const recipientInbox = join(CHOROS_ROOT, recipient.id, 'inbox')
  await mkdir(recipientInbox, { recursive: true })
  const finalPath = join(recipientInbox, `${id}.json`)
  const tmpPath = join(recipientInbox, `.${id}.tmp`)
  await writeFile(tmpPath, payload)
  await rename(tmpPath, finalPath)

  const display = recipient.name ? `${recipient.name} (${recipient.id.slice(0, 8)}…)` : recipient.id
  const live = await recipientLiveness(recipient.id)
  const verifyPath = `${finalPath}.seen`
  const lines = [
    `sent to ${display} (id=${id})`,
    livenessTag(live, verifyPath),
  ]
  return { content: [{ type: 'text', text: lines.join('\n') }] }
})

await mcp.connect(new StdioServerTransport())

// --- Courier inbox watcher: notification-only, no auto-move ---

// Consecutive notification timeouts. Bumped by every Promise.race timeout in
// pushChannelNotification(); reset by any successful resolve. After
// WEDGE_TIMEOUT_THRESHOLD in a row we write .wedged so external monitors
// (cockpit doctor, /choros list, humans) can see CC is not consuming pushes
// despite bun being alive.
let consecutiveTimeouts = 0

async function recordWedge(msgIds: string[]) {
  const payload = JSON.stringify({
    pid: process.pid,
    detected_at: new Date().toISOString(),
    consecutive_timeouts: consecutiveTimeouts,
    pending_msg_ids: msgIds,
  })
  try { await atomicWrite(WEDGE_PATH, payload) }
  catch (e: any) { process.stderr.write(`[choros] wedge marker write failed: ${e?.message ?? e}\n`) }
}

async function clearWedge() {
  try { await unlink(WEDGE_PATH) } catch {}
}

// Wrap mcp.notification in Promise.race(timeout). On EPIPE the SDK's promise
// hangs forever (verified empirically 2026-05-19); without this wrap maybeEmit
// would hang and never write subsequent .seen markers. Returns 'ok' if the
// notification resolved before the timeout, 'timeout' if not.
async function pushChannelNotification(
  msgId: string,
  content: string,
  meta: Record<string, string>,
): Promise<'ok' | 'timeout'> {
  const result = await withTimeout(
    mcp.notification({
      method: 'notifications/claude/channel',
      params: { content, meta },
    }),
    PUSH_TIMEOUT_MS,
    `pushChannelNotification msg_id=${msgId}`,
  )
  if (result === 'ok') {
    if (consecutiveTimeouts > 0) {
      process.stderr.write(`[choros] notification resolved — clearing wedge state (was ${consecutiveTimeouts})\n`)
      consecutiveTimeouts = 0
      await clearWedge()
    }
    return 'ok'
  }
  consecutiveTimeouts++
  process.stderr.write(
    `[choros] notification timed out after ${PUSH_TIMEOUT_MS}ms for msg_id=${msgId} ` +
    `(consecutive=${consecutiveTimeouts}). Likely EPIPE on stdio or wedged Claude Code MCP client.\n`,
  )
  if (consecutiveTimeouts >= WEDGE_TIMEOUT_THRESHOLD) {
    await recordWedge([msgId])
  }
  return 'timeout'
}

// Concurrent-fire guard: maybeEmit can be called from three paths (boot
// pre-scan, inotify watcher, periodic re-emit sweep). Two callers racing on
// the same filename would double-fire the notification. The guard makes
// per-filename calls reentrancy-safe.
const emittingNow = new Set<string>()

// Dropped-ack dedup: when verifyJsonlReceipt fails, we write a .dropped to
// the sender. The sweep retries every 60s; without this Set, every retry
// writes another .dropped, the sender fires another channel event, and the
// sender sees the same "msg X dropped" repeatedly. Track msg_ids we've
// already emitted dropped acks for; the entry is cleared when the same
// msg_id later verifies (so a recovery transition still fires delivered).
const droppedAcksEmitted = new Set<string>()

async function maybeEmit(filename: string) {
  if (!filename.endsWith('.json')) return
  if (filename.startsWith('.')) return
  if (filename.endsWith('.seen')) return
  if (emittingNow.has(filename)) return

  const src = join(MY_INBOX, filename)
  const sidecar = `${src}.seen`
  const archived = join(MY_READ, filename)

  if (existsSync(sidecar)) return
  if (existsSync(archived)) return
  if (!existsSync(src)) return

  emittingNow.add(filename)
  try {
    return await maybeEmitInner(filename, src, sidecar)
  } finally {
    emittingNow.delete(filename)
  }
}

async function maybeEmitInner(filename: string, src: string, sidecar: string) {

  let raw: string
  try { raw = await readFile(src, 'utf8') }
  catch (e: any) {
    if (e?.code === 'ENOENT') return
    throw e
  }

  let data: any
  try { data = JSON.parse(raw) }
  catch (e) {
    process.stderr.write(`[choros] failed to parse ${src}: ${e}\n`)
    return
  }

  const msgId = String(data.id ?? '')
  const meta: Record<string, string> = {
    source: 'choros',
    msg_id: msgId,
    ts: String(data.ts ?? ''),
    from_session: String(data.from_session ?? ''),
    from_name: String(data.from_name ?? 'unknown'),
    from_host: String(data.from_host ?? ''),
    from_cwd: String(data.from_cwd ?? ''),
  }
  if (data.reply_budget != null) meta.reply_budget = String(data.reply_budget)
  if (data.in_reply_to) meta.in_reply_to = String(data.in_reply_to)
  if (data.topic) meta.topic = String(data.topic)
  if (data.broadcast) meta.broadcast = 'true'
  // Mentions: surface whether I was specifically @ed. The full mentions list
  // is in the payload, but `mentioned_me` is the load-bearing flag for the
  // recipient agent — they can route attention based on it.
  if (Array.isArray(data.mentions) && data.mentions.length > 0) {
    const myName = await resolveMyName()
    const mentionedMe = data.mentions.some((m: unknown) =>
      m === ME || (typeof m === 'string' && m === myName))
    if (mentionedMe) meta.mentioned_me = 'true'
    meta.mentions = data.mentions.join(',')
  }

  // Fire FIRST. Only write .seen on confirmed resolve. On timeout, leave the
  // file un-.seen'd so /choros inbox polling discovers it and surfaces it to the
  // agent honestly.
  const result = await pushChannelNotification(msgId, String(data.body ?? ''), meta)
  if (result !== 'ok') return

  // v0.6: SDK promise resolve != CC actually processed the channel push.
  // The observed time-algebra case: mcp.notification() resolves cleanly,
  // the bun writes .seen, but CC silently drops the message and the agent
  // never sees it. Empirical: when delivery genuinely lands, CC writes a
  // queue-operation/user/attachment entry to its own JSONL within ~40 ms.
  // Probe own JSONL for the msg_id after a short window; only commit .seen
  // on confirmation. Sender's verify_path stat then carries real meaning.
  const verified = await verifyJsonlReceipt(msgId, JSONL_VERIFY_TIMEOUT_MS)
  if (!verified) {
    process.stderr.write(
      `[choros] notification resolved but msg_id=${msgId} NOT in own JSONL after ${JSONL_VERIFY_TIMEOUT_MS}ms — ` +
      `CC silently dropped; .seen withheld so sender's verify_path stat is honest. ` +
      `Next sweep will retry.\n`,
    )
    // Emit the .dropped ack only on the FIRST failure for this msg_id. The
    // sweep will keep retrying delivery; we don't need to re-tell the sender
    // every minute that it's still un-delivered.
    if (!droppedAcksEmitted.has(msgId)) {
      droppedAcksEmitted.add(msgId)
      await writeAckToSender(data, 'dropped').catch(e => {
        process.stderr.write(`[choros] failed to write .dropped ack: ${e}\n`)
      })
    }
    return
  }
  // Verified now — if a previous attempt had marked this dropped, clear the
  // dedupe flag so a future drop (e.g. after a CC restart) can re-fire.
  droppedAcksEmitted.delete(msgId)

  const marker = JSON.stringify({
    pushed_at: new Date().toISOString(),
    verified_at: new Date().toISOString(),
    pid: process.pid,
  })
  try {
    await writeFile(sidecar, marker, { flag: 'wx' })
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e
  }

  // v0.8: bi-directional ack. After JSONL-confirmed delivery, drop a tiny
  // .ack file in the sender's sent_acks/ dir. Their bun has an inotify
  // watcher there and pushes a <channel source="choros-ack"> event mid-turn
  // to its own agent, closing the visibility loop. Sender no longer has
  // to stat verify_path — delivery confirmation arrives as a live event.
  await writeAckToSender(data, 'delivered').catch(e => {
    process.stderr.write(`[choros] failed to write .ack: ${e}\n`)
  })
}

/** Drop a tiny ack file in the SENDER's sent_acks/ dir. The sender's bun
 *  is the only process that should read it; its inotify watcher will
 *  surface the ack to its own agent and delete the file. If the sender's
 *  bun is dead the file persists, visible to /choros doctor.
 */
async function writeAckToSender(msg: any, status: 'delivered' | 'dropped'): Promise<void> {
  const fromSession = String(msg.from_session ?? '')
  const msgId = String(msg.id ?? '')
  if (!fromSession || !msgId) return
  try {
    sanitizeId(fromSession, 'inbound msg.from_session')
    sanitizeId(msgId, 'inbound msg.id')
  } catch (e: any) {
    process.stderr.write(`[choros] refusing to ack unsafe inbound msg payload: ${e?.message ?? e}\n`)
    return
  }
  // Refuse self-acks for messages where sender resolves to us — three-layer
  // self-check, not just UUID match (prevents ack loopback through name
  // collision or pid-shared dirs).
  if (await isSelf(fromSession, null)) return
  const senderAcksDir = join(CHOROS_ROOT, fromSession, 'sent_acks')
  try { await mkdir(senderAcksDir, { recursive: true }) } catch {}
  const ext = status === 'delivered' ? 'ack' : 'dropped'
  const path = join(senderAcksDir, `${msgId}.${ext}`)
  // Dedupe: if a .ack or .dropped already exists for this msg_id in the
  // sender's queue, skip the write. The sweep retries un-confirmed pushes
  // every 60s; without this guard, every retry produces a fresh ack file
  // and a fresh channel event for the sender (noise observed in practice).
  if (existsSync(path)) return
  // Cross-status dedupe: a .ack already there means delivered; don't add
  // a .dropped on top. And vice versa — first ack wins.
  const otherExt = ext === 'ack' ? 'dropped' : 'ack'
  if (existsSync(join(senderAcksDir, `${msgId}.${otherExt}`))) return
  const tmp = join(senderAcksDir, `.${msgId}.${ext}.tmp`)
  const payload = JSON.stringify({
    msg_id: msgId,
    status,
    from_session: fromSession,
    to_session: ME,
    to_name: await resolveMyName(),
    verified_at: new Date().toISOString(),
    recipient_pid: process.pid,
  })
  await writeFile(tmp, payload)
  await rename(tmp, path)
}

/** Polls our own CC's JSONL for a substring match on `msg_id`. Returns
 *  true on first match within the timeout. CC writes channel events
 *  (queue-operation, attachment of type queued_command, or direct user
 *  prompt) within ~40 ms of receiving a notification when delivery
 *  actually succeeds. A miss after the timeout window indicates CC
 *  silently dropped the push. Search is by substring (msg_id is unique
 *  enough — 24-char timestamp + 8-char prefix). Best-effort: returns
 *  false on any read error.
 */
async function verifyJsonlReceipt(msgId: string, timeoutMs: number): Promise<boolean> {
  if (!msgId) return false
  const jsonl = await findJsonlForSession(ME)
  if (!jsonl) {
    // No JSONL to probe — fall back to optimistic confirmation (v0.5 behaviour)
    // so we don't regress for sessions where JSONL discovery fails.
    return true
  }
  const deadline = Date.now() + timeoutMs
  const interval = 250
  // Track our scan offset so we don't re-confirm a msg_id that appeared in
  // history before this notification fired. Substring-on-buffer would otherwise
  // false-positive if the msg_id literal happened to appear earlier in the
  // 256 KB tail (e.g., in a quoted older message).
  const startSize = await stat(jsonl).then(s => s.size).catch(() => 0)
  while (Date.now() < deadline) {
    try {
      const fileSize = (await stat(jsonl)).size
      if (fileSize <= startSize) {
        // Nothing new has been written since we started waiting — keep polling.
        await new Promise(r => setTimeout(r, interval))
        continue
      }
      // Read only the bytes that have been APPENDED since this notification
      // fired. The msg_id we're looking for can only legitimately appear in
      // newly-written records.
      const tailBytes = fileSize - startSize
      const fd = await open(jsonl, 'r')
      try {
        const buf = Buffer.alloc(tailBytes)
        await fd.read(buf, 0, tailBytes, startSize)
        if (buf.includes(msgId)) return true
      } finally {
        await fd.close()
      }
    } catch { /* ignore — try again on next tick */ }
    await new Promise(r => setTimeout(r, interval))
  }
  return false
}

// Invalidate orphan .seen sidecars from previous bun lifetimes. A sidecar's
// pid field identifies the bun that wrote it; if that pid is dead, the
// delivery claim is uncertain (especially for v0.4 sidecars, which were
// written BEFORE the notification fired and routinely outlive failed pushes).
// Without this sweep, a v0.4 lying sidecar persists across restart and
// permanently shadows the file from v0.5's pre-scan + sweep. Conservative:
// only delete when the recorded pid is provably dead; live pids (e.g. a
// concurrent sibling, vanishingly rare under per-session-UUID identity) are
// left alone.
async function invalidateOrphanSidecars() {
  const files = await readdir(MY_INBOX).catch(() => [])
  let invalidated = 0
  for (const f of files) {
    if (!f.endsWith('.seen')) continue
    if (f.startsWith('.')) continue
    const sidecarPath = join(MY_INBOX, f)
    let raw: string
    try { raw = await readFile(sidecarPath, 'utf8') } catch { continue }
    let pid: number
    try { pid = Number(JSON.parse(raw).pid) } catch { continue }
    if (!pid || pid === process.pid) continue
    try { process.kill(pid, 0); continue } catch { /* dead — fall through */ }
    try { await unlink(sidecarPath); invalidated++ } catch {}
  }
  if (invalidated > 0) {
    process.stderr.write(`[choros] invalidated ${invalidated} orphan .seen sidecar(s) (dead pid)\n`)
  }
}
await invalidateOrphanSidecars()

const existing = (await readdir(MY_INBOX).catch(() => [])).filter(
  f => f.endsWith('.json') && !f.startsWith('.') && !f.endsWith('.seen'),
)
for (const f of existing.sort()) await maybeEmit(f)

// Periodic re-emit sweep. After a v0.5 push timeout the inbox file stays
// un-.seen'd with no inotify event to retry it; without this sweep a
// transient wedge produces a permanent silent loss for autonomous agents
// that never run /choros inbox. Sweep cadence is conservative (60 s) — fast
// enough to recover within one human idle cycle, slow enough to not retry-
// flood a still-wedged channel. The maybeEmit guard prevents the sweep from
// double-firing with the inotify watcher path.
const RESWEEP_INTERVAL_MS = 60_000
let sweepInFlight = false
async function reemitSweep() {
  if (sweepInFlight) return
  sweepInFlight = true
  try {
    const files = (await readdir(MY_INBOX).catch(() => []))
      .filter(f => f.endsWith('.json') && !f.startsWith('.') && !f.endsWith('.seen'))
      .filter(f => !existsSync(`${join(MY_INBOX, f)}.seen`))
    if (files.length === 0) return
    process.stderr.write(`[choros] sweep: retrying ${files.length} un-pushed file(s)\n`)
    for (const f of files) {
      try { await maybeEmit(f) }
      catch (e) { process.stderr.write(`[choros] sweep emit error for ${f}: ${e}\n`) }
    }
  } finally {
    sweepInFlight = false
  }
}
const sweepTimer = setInterval(reemitSweep, RESWEEP_INTERVAL_MS)
sweepTimer.unref?.()

const watcher = spawn(
  'inotifywait',
  ['-m', '-q', '-e', 'close_write,moved_to', '--format', '%f', MY_INBOX],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)
watcherRef = watcher  // make killable from exit handlers
watcher.stdout.on('data', async (chunk: Buffer) => {
  const lines = chunk.toString().split('\n').filter(Boolean)
  for (const line of lines) {
    try { await maybeEmit(line) }
    catch (e) { process.stderr.write(`[choros] emit error for ${line}: ${e}\n`) }
  }
})
watcher.stderr.on('data', d => process.stderr.write(`[inotify] ${d}`))
watcher.on('exit', code => {
  process.stderr.write(`[choros] inotifywait exited with ${code}\n`)
  releaseLock()
  process.exit(code ?? 1)
})

// v0.8: ACK watcher. When a recipient bun confirms JSONL-receipt (or
// detects drop), they drop an ack file into our sent_acks/ dir. We watch
// for those, push a <channel source="choros-ack"> event to our own agent
// mid-turn, then clean the file.
async function emitAck(filename: string) {
  if (filename.startsWith('.')) return
  const isAck = filename.endsWith('.ack') || filename.endsWith('.dropped')
  const isReact = filename.endsWith('.react')
  const isRead = filename.endsWith('.read')
  if (!isAck && !isReact && !isRead) return
  const path = join(MY_ACKS, filename)
  let raw: string
  try { raw = await readFile(path, 'utf8') }
  catch (e: any) { if (e?.code === 'ENOENT') return; throw e }
  let data: any
  try { data = JSON.parse(raw) }
  catch (e) {
    process.stderr.write(`[choros] failed to parse ack ${path}: ${e}\n`)
    return
  }

  let meta: Record<string, string>
  let content: string
  if (isReact) {
    meta = {
      source: 'choros-reaction',
      msg_id: String(data.msg_id ?? ''),
      emoji: String(data.emoji ?? ''),
      from_session: String(data.from_session ?? ''),
      from_name: String(data.from_name ?? ''),
      ts: String(data.ts ?? ''),
    }
    const reactor = data.from_name || (data.from_session ? String(data.from_session).slice(0, 8) : 'unknown')
    content = `${reactor} reacted ${data.emoji} to msg_id=${data.msg_id}`
  } else if (isRead) {
    meta = {
      source: 'choros-read',
      msg_id: String(data.msg_id ?? ''),
      by_session: String(data.by_session ?? ''),
      by_name: String(data.by_name ?? ''),
      read_at: String(data.read_at ?? ''),
    }
    const reader = data.by_name || (data.by_session ? String(data.by_session).slice(0, 8) : 'unknown')
    content = `${reader} read msg_id=${data.msg_id}`
  } else {
    meta = {
      source: 'choros-ack',
      msg_id: String(data.msg_id ?? ''),
      status: String(data.status ?? ''),
      to_session: String(data.to_session ?? ''),
      to_name: String(data.to_name ?? ''),
      verified_at: String(data.verified_at ?? ''),
    }
    const recipient = data.to_name || data.to_session
    content = data.status === 'delivered'
      ? `Delivered to ${recipient}: msg_id=${data.msg_id}`
      : `Dropped — recipient bun could not confirm receipt at ${recipient}: msg_id=${data.msg_id}`
  }

  const result = await withTimeout(
    mcp.notification({
      method: 'notifications/claude/channel',
      params: { content, meta },
    }),
    PUSH_TIMEOUT_MS,
    `emit ${filename}`,
  )
  if (result === 'ok') {
    try { await unlink(path) } catch {}
  } else {
    process.stderr.write(
      `[choros] ${isReact ? 'reaction' : 'ack'} push timed out for msg_id=${data.msg_id}; leaving ${path} on disk\n`,
    )
  }
}

// Pre-scan existing ack-like files at boot (landed while bun was offline).
const existingAcks = (await readdir(MY_ACKS).catch(() => [])).filter(
  f => !f.startsWith('.')
    && (f.endsWith('.ack') || f.endsWith('.dropped') || f.endsWith('.react') || f.endsWith('.read')),
)
for (const f of existingAcks.sort()) await emitAck(f)

const ackWatcher = spawn(
  'inotifywait',
  ['-m', '-q', '-e', 'close_write,moved_to', '--format', '%f', MY_ACKS],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)
let ackWatcherRef: ChildProcess | null = ackWatcher
ackWatcher.stdout.on('data', async (chunk: Buffer) => {
  const lines = chunk.toString().split('\n').filter(Boolean)
  for (const line of lines) {
    try { await emitAck(line) }
    catch (e) { process.stderr.write(`[choros] ack emit error for ${line}: ${e}\n`) }
  }
})
ackWatcher.stderr.on('data', d => process.stderr.write(`[ack-inotify] ${d}`))
ackWatcher.on('exit', code => {
  process.stderr.write(`[choros] ack inotifywait exited with ${code}\n`)
  ackWatcherRef = null
  // Don't kill ourselves on ack-watcher exit; inbox watcher is the
  // load-bearing one. Best-effort: continue without ack notifications.
})

// v0.14: read-receipt emission. When /choros read archives an inbox file
// into read/, this watcher catches the moved_to event, looks up the
// original sender, and writes a .read file to their sent_acks/ — same
// channel the existing ack watcher consumes. The sender's bun forwards
// it as <channel source="choros-read">. Stronger signal than delivery: the
// agent actually engaged with the message (archived it, possibly after
// reading/replying/reacting). Boot pre-scan deliberately skipped — read
// receipts only fire for archives that happen during this bun's lifetime
// (avoids spamming senders with late receipts on bun restart).
async function emitReadReceipt(filename: string) {
  if (filename.startsWith('.')) return
  if (!filename.endsWith('.json')) return
  const path = join(MY_READ, filename)
  let raw: string
  try { raw = await readFile(path, 'utf8') }
  catch (e: any) { if (e?.code === 'ENOENT') return; throw e }
  let data: any
  try { data = JSON.parse(raw) }
  catch (e) {
    process.stderr.write(`[choros] read-receipt: parse failed for ${path}: ${e}\n`)
    return
  }
  const fromSession = data.from_session
  const msgId = data.id
  if (!fromSession || !msgId) return
  try {
    sanitizeId(String(fromSession), 'read-receipt.from_session')
    sanitizeId(String(msgId), 'read-receipt.msg_id')
  } catch (e: any) {
    process.stderr.write(`[choros] read-receipt: refusing unsafe payload (${e?.message ?? e})\n`)
    return
  }
  if (await isSelf(String(fromSession), null)) return
  const myName = await resolveMyName()
  const senderAcksDir = join(CHOROS_ROOT, fromSession, 'sent_acks')
  try { await mkdir(senderAcksDir, { recursive: true }) } catch {}
  const receiptName = `${msgId}.${ME.slice(0, 8)}.read`
  const receiptPath = join(senderAcksDir, receiptName)
  const tmp = join(senderAcksDir, `.${receiptName}.tmp`)
  const payload = JSON.stringify({
    msg_id: msgId,
    status: 'read',
    by_session: ME,
    by_name: myName,
    read_at: new Date().toISOString(),
  })
  try {
    await writeFile(tmp, payload)
    await rename(tmp, receiptPath)
  } catch (e: any) {
    process.stderr.write(`[choros] read-receipt write failed for msg_id=${msgId}: ${e?.message ?? e}\n`)
  }
}

const readWatcher = spawn(
  'inotifywait',
  ['-m', '-q', '-e', 'close_write,moved_to', '--format', '%f', MY_READ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)
let readWatcherRef: ChildProcess | null = readWatcher
readWatcher.stdout.on('data', async (chunk: Buffer) => {
  const lines = chunk.toString().split('\n').filter(Boolean)
  for (const line of lines) {
    try { await emitReadReceipt(line) }
    catch (e) { process.stderr.write(`[choros] read-receipt error for ${line}: ${e}\n`) }
  }
})
readWatcher.stderr.on('data', d => process.stderr.write(`[read-inotify] ${d}`))
readWatcher.on('exit', code => {
  process.stderr.write(`[choros] read inotifywait exited with ${code}\n`)
  readWatcherRef = null
})

// v0.9: presence channel. When bun boots, drop a .hello in every live
// peer's presence/ dir. When bun cleanShutdowns, drop a .goodbye. Each
// peer's bun watches its own presence/, surfaces the join/leave as a
// <channel source="choros-presence"> event to its own agent. New sessions
// learn about existing ones (incoming hellos from the joiner are received
// by all peers; the joiner emits a roster event listing who was already
// up). Goal: starting N sessions in any order, every session knows about
// the N-1 others.

async function writePresence(peerId: string, kind: 'hello' | 'goodbye', myName: string) {
  if (peerId === ME) return
  const peerPresenceDir = join(CHOROS_ROOT, peerId, 'presence')
  try { await mkdir(peerPresenceDir, { recursive: true }) } catch {}
  const tsId = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const path = join(peerPresenceDir, `${tsId}-${ME.slice(0, 8)}.${kind}`)
  const tmp = join(peerPresenceDir, `.${tsId}-${ME.slice(0, 8)}.${kind}.tmp`)
  const payload = JSON.stringify({
    event: kind === 'hello' ? 'join' : 'leave',
    peer_id: ME,
    peer_name: myName,
    peer_host: hostname(),
    peer_cwd: process.cwd(),
    ts: new Date().toISOString(),
  })
  try {
    await writeFile(tmp, payload)
    await rename(tmp, path)
  } catch (e: any) {
    process.stderr.write(`[choros] presence ${kind} write to ${peerId.slice(0, 8)} failed: ${e?.message ?? e}\n`)
  }
}

async function broadcastPresence(kind: 'hello' | 'goodbye') {
  const myName = await resolveMyName()
  const known = await listKnownInstances()
  const livePeers: { id: string; name: string | null }[] = []
  for (const k of known) {
    // 1. Same UUID = literally me.
    if (k.id === ME) continue
    // 2. Same display name = I shouldn't see myself in the roster even if
    //    another dir/legacy entry/colliding rename happens to surface my
    //    own name. If a *real* sibling has actually /rename'd to my name,
    //    surface the collision in stderr so it's diagnosable, then skip.
    if (k.name && k.name === myName) {
      process.stderr.write(
        `[choros] peer ${k.id.slice(0, 8)} shares my display name "${myName}" — ` +
        `excluding from presence to avoid self-listing. ` +
        `If this is a legitimate sibling, /rename one of us.\n`,
      )
      continue
    }
    try {
      // 3. Same heartbeat PID = somehow we're staring at our own .heartbeat
      //    under a different path. Defensive — shouldn't happen, but if it
      //    does (e.g. legacy dir got a stale copy of our pid), skip.
      const hb = await readFile(join(CHOROS_ROOT, k.id, '.heartbeat'), 'utf8')
      try {
        const hbData = JSON.parse(hb)
        if (hbData?.pid === process.pid) continue
      } catch { /* unparseable heartbeat — fall through to liveness check */ }
    } catch { /* no heartbeat, skip */ }
    // 4. Liveness: heartbeat fresh AND bun process alive. A bun that exited
    //    seconds ago still has a fresh-mtime .heartbeat — the kernel doesn't
    //    invalidate file mtime on the writer's death — so mtime alone
    //    classifies a ghost peer as live. Anchor on /proc/<pid> instead.
    if (await isLivePeer(k.id)) livePeers.push({ id: k.id, name: k.name })
  }
  await Promise.all(livePeers.map(p => writePresence(p.id, kind, myName)))
  return livePeers
}

async function emitPresence(filename: string) {
  if (filename.startsWith('.')) return
  if (!filename.endsWith('.hello') && !filename.endsWith('.goodbye')) return
  const path = join(MY_PRESENCE, filename)
  let raw: string
  try { raw = await readFile(path, 'utf8') }
  catch (e: any) { if (e?.code === 'ENOENT') return; throw e }
  let data: any
  try { data = JSON.parse(raw) }
  catch (e) {
    process.stderr.write(`[choros] failed to parse presence ${path}: ${e}\n`)
    return
  }
  // Defensive: if a presence file for ourselves somehow lands in our own
  // presence/ dir (broadcast loopback, dir confusion, etc.), suppress it.
  // Agents shouldn't see themselves join/leave.
  if (data.peer_id === ME) {
    try { await unlink(path) } catch {}
    return
  }
  const peerLabel = data.peer_name || data.peer_id?.slice(0, 8)
  const meta: Record<string, string> = {
    source: 'choros-presence',
    event: String(data.event ?? ''),
    peer_id: String(data.peer_id ?? ''),
    peer_name: String(data.peer_name ?? ''),
    peer_host: String(data.peer_host ?? ''),
    peer_cwd: String(data.peer_cwd ?? ''),
    ts: String(data.ts ?? ''),
  }
  // emitPresence handles inbound .hello/.goodbye → event in {join, leave}.
  // The roster event is fired directly at boot, not through this path.
  let content: string
  if (data.event === 'join') content = `Peer ${peerLabel} came online`
  else if (data.event === 'leave') content = `Peer ${peerLabel} went offline`
  else content = `Peer ${peerLabel} presence event: ${data.event}`

  const result = await withTimeout(
    mcp.notification({
      method: 'notifications/claude/channel',
      params: { content, meta },
    }),
    PUSH_TIMEOUT_MS,
    `emit ${filename}`,
  )
  if (result === 'ok') {
    try { await unlink(path) } catch {}
  } else {
    process.stderr.write(`[choros] presence push timed out for ${filename}; leaving on disk\n`)
  }
}

// Pre-scan existing presence (acks that landed while bun was offline).
const existingPresence = (await readdir(MY_PRESENCE).catch(() => [])).filter(
  f => !f.startsWith('.') && (f.endsWith('.hello') || f.endsWith('.goodbye')),
)
for (const f of existingPresence.sort()) await emitPresence(f)

const presenceWatcher = spawn(
  'inotifywait',
  ['-m', '-q', '-e', 'close_write,moved_to', '--format', '%f', MY_PRESENCE],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)
let presenceWatcherRef: ChildProcess | null = presenceWatcher
presenceWatcher.stdout.on('data', async (chunk: Buffer) => {
  const lines = chunk.toString().split('\n').filter(Boolean)
  for (const line of lines) {
    try { await emitPresence(line) }
    catch (e) { process.stderr.write(`[choros] presence emit error for ${line}: ${e}\n`) }
  }
})
presenceWatcher.stderr.on('data', d => process.stderr.write(`[presence-inotify] ${d}`))
presenceWatcher.on('exit', code => {
  process.stderr.write(`[choros] presence inotifywait exited with ${code}\n`)
  presenceWatcherRef = null
})

// Broadcast hello to live peers and emit a roster event for ourselves.
const helloPeers = await broadcastPresence('hello')
if (helloPeers.length > 0) {
  const labels = helloPeers
    .map(p => p.name || p.id.slice(0, 8))
    .sort()
    .join(', ')
  const rosterMeta: Record<string, string> = {
    source: 'choros-presence',
    event: 'roster',
    peer_ids: helloPeers.map(p => p.id).join(','),
    peer_names: helloPeers.map(p => p.name ?? p.id.slice(0, 8)).join(','),
    count: String(helloPeers.length),
  }
  // Fire-and-forget; same timeout discipline as other channel pushes.
  await withTimeout(
    mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: `Other agents online: ${labels}`,
        meta: rosterMeta,
      },
    }),
    PUSH_TIMEOUT_MS,
    'boot-roster',
  )
}

const bootName = await resolveMyName()
process.stderr.write(
  `[choros] v0.17 channel up: session=${ME} (source=${ID_SOURCE}) name="${bootName}"\n` +
  `[choros] inbox=${MY_INBOX}  lock=${LOCK_PATH}  heartbeat=${HEARTBEAT_PATH}  pid=${process.pid}\n` +
  `[choros] push timeout=${PUSH_TIMEOUT_MS}ms; wedge threshold=${WEDGE_TIMEOUT_THRESHOLD}; wedge marker=${WEDGE_PATH}\n` +
  `[choros] presence broadcast to ${helloPeers.length} live peer(s)\n`,
)
// Stale .wedged from a previous bun lifetime: clear it now so the marker
// reflects only this process's view. A real wedge will recreate it within
// WEDGE_TIMEOUT_THRESHOLD × PUSH_TIMEOUT_MS seconds.
await clearWedge()
