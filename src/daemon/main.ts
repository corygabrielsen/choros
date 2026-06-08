#!/usr/bin/env bun
/**
 * choros daemon — long-lived bun process backing every per-session
 * MCP shim.
 *
 * State root: ~/.local/state/choros (or $CHOROS_STATE_HOME). choros
 * does NOT honor $XDG_STATE_HOME — see state-root.ts for why.
 *
 * Sockets:
 *   <state-root>/daemon.sock  (JSON-RPC for shims)
 *   <state-root>/admin.sock   (HTTP for humans + cockpit)
 *
 * Storage:
 *   <state-root>/choros.sqlite  (WAL-mode SQLite)
 *
 * Lockfile:
 *   <state-root>/daemon.lock    (single-instance enforcement)
 *
 * Lifecycle: launched by systemd / launchd / `bun run daemon`. Single
 * instance per user enforced by the lockfile (which encodes the pid +
 * a liveness check via `/proc` or `kill(pid, 0)`).
 */
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEAD_AGE_MS, VACATED_TTL_MS } from '#choros/constants.ts'
import { startAdminServer } from '#choros/daemon/admin.ts'
import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { broadcastDaemonLifecycle } from '#choros/daemon/notify.ts'
import { RenewalCoordinator, realClock } from '#choros/daemon/renewal.ts'
import { startRpcServer } from '#choros/daemon/rpc.ts'
import { SessionRouter } from '#choros/daemon/sessions.ts'
import {
  clearSessionLock,
  clearStaleLocks,
  listLockedSessions,
  openStorage,
} from '#choros/daemon/storage.ts'
import {
  adminSocketPath,
  daemonSocketPath,
  databasePath,
  lockfilePath,
  resolveStateRootFromEnv,
} from '#choros/state-root.ts'

const VERSION = '1.0.0'

// Resolve all paths up front. A bad env override (e.g. a relative
// CHOROS_STATE_HOME) makes the resolvers throw — and this runs at
// module top level, before the uncaughtException handler is installed,
// so an unguarded throw dies with a raw stack. Frame it.
let STATE_ROOT: string
let SOCKET_PATH: string
let ADMIN_SOCKET_PATH: string
let DB_PATH: string
let LOCK_PATH: string
try {
  STATE_ROOT = resolveStateRootFromEnv()
  SOCKET_PATH = daemonSocketPath()
  ADMIN_SOCKET_PATH = adminSocketPath()
  DB_PATH = databasePath()
  LOCK_PATH = lockfilePath()
} catch (e: unknown) {
  const m = e instanceof Error ? e.message : String(e)
  process.stderr.write(`[choros-daemon] bad configuration: ${m}\n`)
  process.exit(1)
}
// 0700 so the SQLite database (which holds message bodies +
// agent_status/intent set by other CCs) isn't world-traversable. The
// sockets each chmod themselves to 0600, but without this dir mode
// the DB sits open at default umask (0755). The mkdir `mode` option
// only applies when the dir is freshly created, so also chmod
// explicitly to fix the mode on an existing dir created at default
// umask by an older daemon version.
mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 })
try {
  chmodSync(STATE_ROOT, 0o700)
} catch (e: unknown) {
  const m = e instanceof Error ? e.message : String(e)
  process.stderr.write(`[choros-daemon] STATE_ROOT chmod failed: ${m}\n`)
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    // Signal 0 doesn't deliver but raises ESRCH if the pid is gone.
    process.kill(pid, 0)
    return true
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code
    // EPERM means the pid exists but we can't signal it — still alive.
    return code === 'EPERM'
  }
}

/** Refuse to start when another daemon is already running for this
 *  user. Writes our pid into the lockfile; reads any prior holder and
 *  rejects when their pid is live. */
function acquireLockfile(): void {
  try {
    const raw = readFileSync(LOCK_PATH, 'utf8')
    const holder = JSON.parse(raw) as { pid?: number; started?: string }
    if (typeof holder?.pid === 'number' && holder.pid !== process.pid && isPidAlive(holder.pid)) {
      process.stderr.write(
        `[choros-daemon] another daemon (pid ${holder.pid}, started ${holder.started ?? '?'}) holds the lockfile. Refusing to start.\n`,
      )
      process.exit(1)
    }
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code && code !== 'ENOENT') {
      process.stderr.write(`[choros-daemon] lockfile read error (${code}); proceeding\n`)
    }
    /* missing lockfile is the expected first-boot path */
  }
  writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }))
}

/** Remove a stale socket inode from a prior daemon's clean exit OR
 *  crash. Refuses to delete non-socket files at the same path — that
 *  would be a misconfiguration we shouldn't silently paper over. */
function unlinkSocketIfPresent(path: string): void {
  try {
    const stat = lstatSync(path)
    if (!stat.isSocket()) {
      process.stderr.write(
        `[choros-daemon] refusing to delete non-socket file at ${path} (mode=${stat.mode.toString(8)})\n`,
      )
      process.exit(1)
    }
    unlinkSync(path)
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code && code !== 'ENOENT') {
      process.stderr.write(`[choros-daemon] socket unlink failed (${code}); proceeding\n`)
    }
  }
}

acquireLockfile()
for (const p of [SOCKET_PATH, ADMIN_SOCKET_PATH]) {
  unlinkSocketIfPresent(p)
  mkdirSync(dirname(p), { recursive: true })
}

let storage: ReturnType<typeof openStorage>
try {
  storage = openStorage(DB_PATH)
} catch (e: unknown) {
  const m = e instanceof Error ? e.message : String(e)
  process.stderr.write(
    `[choros-daemon] storage open failed (${m}). If this is a schema downgrade, rerun with the matching daemon binary or wipe ${DB_PATH}.\n`,
  )
  process.exit(1)
}

const router = new SessionRouter()

// Track every in-flight handler so shutdown can drain them before we
// close the DB. A handler is just synchronous bun:sqlite ops today,
// but Phase 2+ async additions (display-name lookups, etc.) must
// settle before storage.close() runs.
const inFlight = new Set<Promise<unknown>>()
function trackHandler<T>(p: Promise<T>): Promise<T> {
  inFlight.add(p)
  p.finally(() => inFlight.delete(p))
  return p
}

// Daemon process start time, stamped once at boot. Returned to every
// register handshake so shims can detect a daemon restart by comparing
// against their cached value (see shim's NOTIFY_DAEMON emission).
const STARTED_AT = new Date().toISOString()

const renewal = new RenewalCoordinator(realClock, VACATED_TTL_MS)

const ctx: HandlerCtx = {
  storage,
  router,
  daemon: { version: VERSION, startedAt: STARTED_AT },
  renewal,
  nowIso: () => new Date().toISOString(),
}

const rpc = startRpcServer({ socketPath: SOCKET_PATH, ctx })
const admin = startAdminServer({
  socketPath: ADMIN_SOCKET_PATH,
  storage,
  router,
})

void trackHandler // reserved for Phase 2+ async handler dispatch

/** Reconcile session-table locks with reality. Two passes:
 *
 *  1. Stale-heartbeat sweep: any row whose `lock_pid` is set but whose
 *     `heartbeat_at` is older than `DEAD_AGE_MS` (10 min) had its shim
 *     die without deregistering — almost always a daemon crash or
 *     `kill -9` on the shim. Clear the lock.
 *
 *  2. Dead-PID sweep: any row whose `lock_pid` points at a PID that
 *     isn't currently running. Catches shims that died very recently
 *     (before the heartbeat-age threshold trips) and shims orphaned
 *     across a daemon restart where the PID was recycled.
 *
 *  Row history (display_name, agent_status, message FKs) is preserved;
 *  only the lock columns get cleared. Runs at boot AND on a periodic
 *  timer so a long-running daemon also cleans up after itself. */
function reconcileSessionLocks(): void {
  const cutoff = new Date(Date.now() - DEAD_AGE_MS).toISOString()
  const staleCleared = clearStaleLocks(storage, cutoff)
  let deadCleared = 0
  for (const row of listLockedSessions(storage)) {
    if (!isPidAlive(row.lock_pid)) {
      clearSessionLock(storage, row.id)
      deadCleared++
    }
  }
  if (staleCleared > 0 || deadCleared > 0) {
    process.stderr.write(
      `[choros-daemon] reconcile: cleared ${staleCleared} stale-heartbeat lock(s), ${deadCleared} dead-PID lock(s)\n`,
    )
  }
}

reconcileSessionLocks()
const reconcileTimer = setInterval(reconcileSessionLocks, DEAD_AGE_MS)
reconcileTimer.unref()

process.stderr.write(
  `[choros-daemon] v${VERSION} listening on rpc=${SOCKET_PATH} admin=${ADMIN_SOCKET_PATH} db=${DB_PATH}\n`,
)

/** Overall shutdown hard deadline. If any phase wedges past this, the
 *  process hard-exits with the lockfile and sockets still in place
 *  rather than blocking forever — the next start's stale-pid check
 *  will clean them up. */
const SHUTDOWN_DEADLINE_MS = 5_000

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    // Second signal during a stuck shutdown — hard-exit. Otherwise the
    // operator's reflex Ctrl-C / second SIGTERM is silently swallowed.
    process.stderr.write(`[choros-daemon] ${signal} (second) — hard exit\n`)
    process.exit(130)
    return
  }
  shuttingDown = true
  process.stderr.write(`[choros-daemon] ${signal} received, stopping\n`)
  // Tell every live peer we're going away before the sockets close, so
  // each CC can frame the imminent disconnect + reconnect burst rather
  // than treat it as four sessions silently churning.
  try {
    broadcastDaemonLifecycle(
      ctx,
      'shutting_down',
      `choros daemon stopping (${signal}); peers will reconnect when it restarts`,
    )
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e)
    process.stderr.write(`[choros-daemon] shutdown lifecycle broadcast failed: ${m}\n`)
  }
  // Drop every deferred join/leave timer. Deferred broadcasts are
  // transient — firing them post-shutdown would race the socket close
  // and confuse consumers. Clients reconcile via the roster on
  // reconnect.
  renewal.shutdown()
  const hardExitTimer = setTimeout(() => {
    process.stderr.write(
      `[choros-daemon] shutdown wedged past ${SHUTDOWN_DEADLINE_MS}ms — hard exit\n`,
    )
    process.exit(1)
  }, SHUTDOWN_DEADLINE_MS)
  hardExitTimer.unref()
  // Stop accepting new connections first.
  await Promise.allSettled([rpc.stop(), admin.stop()])
  // Drain any in-flight handlers before closing the DB. 2s deadline
  // mirrors the v0 drain budget; a wedged handler must not block exit.
  if (inFlight.size > 0) {
    process.stderr.write(`[choros-daemon] draining ${inFlight.size} in-flight handler(s)\n`)
    await Promise.race([
      Promise.allSettled([...inFlight]),
      new Promise<void>(resolve => setTimeout(resolve, 2_000)),
    ])
  }
  try {
    storage.close()
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e)
    process.stderr.write(`[choros-daemon] storage.close threw: ${m}\n`)
  }
  for (const p of [SOCKET_PATH, ADMIN_SOCKET_PATH, LOCK_PATH]) {
    try {
      unlinkSync(p)
    } catch {
      /* already gone */
    }
  }
  clearTimeout(hardExitTimer)
  process.exit(0)
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    void shutdown(sig)
  })
}

// Convert unhandled JS errors into a clean shutdown rather than
// leaking the lockfile + sockets. Crashing without unlinking would
// strand the next daemon launch behind a stale-pid check.
process.on('uncaughtException', err => {
  process.stderr.write(`[choros-daemon] uncaughtException: ${err.stack ?? err.message}\n`)
  void shutdown('uncaughtException')
})
process.on('unhandledRejection', reason => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  process.stderr.write(`[choros-daemon] unhandledRejection: ${msg}\n`)
  void shutdown('unhandledRejection')
})
