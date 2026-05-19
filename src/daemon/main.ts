#!/usr/bin/env bun
/**
 * choros daemon — long-lived bun process backing every per-session
 * MCP shim.
 *
 * Sockets:
 *   $XDG_STATE_HOME/choros/daemon.sock  (JSON-RPC for shims)
 *   $XDG_STATE_HOME/choros/admin.sock   (HTTP for humans + cockpit)
 *
 * Storage:
 *   $XDG_STATE_HOME/choros/choros.sqlite  (WAL-mode SQLite)
 *
 * Lockfile:
 *   $XDG_STATE_HOME/choros/daemon.lock    (single-instance enforcement)
 *
 * Lifecycle: launched by systemd / launchd / `bun run daemon`. Single
 * instance per user enforced by the lockfile (which encodes the pid +
 * a liveness check via `/proc` or `kill(pid, 0)`).
 */
import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { startAdminServer } from '#choros/daemon/admin.ts'
import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { startRpcServer } from '#choros/daemon/rpc.ts'
import { SessionRouter } from '#choros/daemon/sessions.ts'
import { openStorage } from '#choros/daemon/storage.ts'
import {
  adminSocketPath,
  daemonSocketPath,
  databasePath,
  lockfilePath,
  resolveStateRootFromEnv,
} from '#choros/state-root.ts'

const VERSION = '1.0.0'

const STATE_ROOT = resolveStateRootFromEnv()
mkdirSync(STATE_ROOT, { recursive: true })

const SOCKET_PATH = daemonSocketPath()
const ADMIN_SOCKET_PATH = adminSocketPath()
const DB_PATH = databasePath()
const LOCK_PATH = lockfilePath()

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

const ctx: HandlerCtx = {
  storage,
  router,
  daemon: { version: VERSION },
  nowIso: () => new Date().toISOString(),
}

const rpc = startRpcServer({ socketPath: SOCKET_PATH, ctx })
const admin = startAdminServer({
  socketPath: ADMIN_SOCKET_PATH,
  storage,
  router,
})

void trackHandler // reserved for Phase 2+ async handler dispatch

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
