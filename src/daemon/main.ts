#!/usr/bin/env bun
/**
 * choros daemon — long-lived bun process backing every per-session
 * MCP shim. Replaces the per-CC-bun model from v0.x.
 *
 * Sockets:
 *   $XDG_STATE_HOME/choros/daemon.sock  (JSON-RPC for shims)
 *   $XDG_STATE_HOME/choros/admin.sock   (HTTP for humans + cockpit)
 *
 * Storage:
 *   $XDG_STATE_HOME/choros/choros.sqlite  (WAL-mode SQLite)
 *
 * Lifecycle: launched by systemd / launchd / `bun run daemon`. Single
 * instance per user enforced by the OS-level service manager (or by
 * EADDRINUSE on the JSON-RPC socket bind for the manual case).
 */
import { mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { startAdminServer } from '#choros/daemon/admin.ts'
import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { startRpcServer } from '#choros/daemon/rpc.ts'
import { SessionRouter } from '#choros/daemon/sessions.ts'
import { openStorage } from '#choros/daemon/storage.ts'

const VERSION = '0.30.0-daemon-phase1'

function resolveStateRoot(): string {
  const explicit = process.env.CHOROS_STATE_HOME?.trim()
  if (explicit) return explicit
  const xdg = process.env.XDG_STATE_HOME?.trim()
  if (xdg) return `${xdg}/choros`
  const home = process.env.HOME?.trim()
  if (home) return `${home}/.local/state/choros`
  return '/tmp/choros'
}

const STATE_ROOT = resolveStateRoot()
mkdirSync(STATE_ROOT, { recursive: true })

const SOCKET_PATH = `${STATE_ROOT}/daemon.sock`
const ADMIN_SOCKET_PATH = `${STATE_ROOT}/admin.sock`
const DB_PATH = `${STATE_ROOT}/choros.sqlite`

// Bun.listen on a Unix path errors with EADDRINUSE if a previous
// daemon left a stale socket inode. Clean it up before bind — the
// OS-level service manager guarantees we're the only instance.
for (const p of [SOCKET_PATH, ADMIN_SOCKET_PATH]) {
  try {
    unlinkSync(p)
  } catch {
    /* not present yet — expected on first boot */
  }
  mkdirSync(dirname(p), { recursive: true })
}

const storage = openStorage(DB_PATH)
const router = new SessionRouter()
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

process.stderr.write(
  `[choros-daemon] v${VERSION} listening on rpc=${SOCKET_PATH} admin=${ADMIN_SOCKET_PATH} db=${DB_PATH}\n`,
)

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write(`[choros-daemon] ${signal} received, stopping\n`)
  await Promise.allSettled([rpc.stop(), admin.stop()])
  storage.close()
  for (const p of [SOCKET_PATH, ADMIN_SOCKET_PATH]) {
    try {
      unlinkSync(p)
    } catch {
      /* already gone */
    }
  }
  process.exit(0)
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    void shutdown(sig)
  })
}
