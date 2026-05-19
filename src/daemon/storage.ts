import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SQL_DIR = `${HERE}/../sql`

/** Current schema version the daemon binary expects. `applyMigrations`
 *  brings any older database up to this number. Bump when adding a new
 *  migration file `src/sql/NNN-*.sql`. */
export const SCHEMA_VERSION = 1

/** Ordered migration files. Each is applied if and only if the current
 *  `system_meta.schema_version` is below the file's target version.
 *  Files are read at module load so the daemon binary embeds them. */
const MIGRATIONS: { version: number; sql: string }[] = [
  { version: 1, sql: readFileSync(`${SQL_DIR}/000-init.sql`, 'utf8') },
]

/** Opaque storage handle. Daemon code uses `db` directly for queries
 *  via `bun:sqlite`'s prepared-statement API. Tests pass an in-memory
 *  database via {@link openStorage}(':memory:'). */
export interface Storage {
  db: Database
  close(): void
}

/** Open or create a choros daemon database at `path`. WAL is enabled
 *  so a reader is never blocked by an in-progress writer (matters
 *  because the admin HTTP endpoint reads concurrently with the RPC
 *  handlers' writes). Foreign keys are enforced. */
export function openStorage(path: string): Storage {
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  applyMigrations(db)
  return {
    db,
    close(): void {
      db.close()
    },
  }
}

function readSchemaVersion(db: Database): number {
  // Brand-new DB: system_meta doesn't exist yet. Return 0 so every
  // migration applies in order.
  const exists = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='system_meta'")
    .get() as { name: string } | null
  if (!exists) return 0
  const row = db.query("SELECT value FROM system_meta WHERE key = 'schema_version'").get() as {
    value: string
  } | null
  if (!row) return 0
  const v = Number.parseInt(row.value, 10)
  return Number.isFinite(v) ? v : 0
}

function applyMigrations(db: Database): void {
  const current = readSchemaVersion(db)
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    db.transaction(() => {
      db.exec(m.sql)
      db.query("INSERT OR REPLACE INTO system_meta(key, value) VALUES ('schema_version', ?)").run(
        String(m.version),
      )
    })()
  }
  const after = readSchemaVersion(db)
  if (after !== SCHEMA_VERSION) {
    throw new Error(
      `choros: schema migration ended at version ${after}, expected ${SCHEMA_VERSION}`,
    )
  }
}

/* --- Session row queries used by Phase 1 handlers ---------------------- */

export interface SessionRow {
  id: string
  display_name: string | null
  host: string | null
  cwd: string | null
  lock_pid: number | null
  lock_started_at: string | null
  heartbeat_at: string | null
  agent_status: string | null
  agent_intent: string | null
  wedged_at: string | null
  wedge_pending: string | null
}

/** Upsert a session's identity + lock. Called from the register
 *  handler. Returns the row as it now exists in the DB. */
export function upsertSession(
  storage: Storage,
  args: {
    id: string
    display_name: string | null
    host: string
    cwd: string
    pid: number
    nowIso: string
  },
): SessionRow {
  storage.db
    .query(
      `INSERT INTO sessions (id, display_name, host, cwd, lock_pid, lock_started_at, heartbeat_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         display_name = excluded.display_name,
         host = excluded.host,
         cwd = excluded.cwd,
         lock_pid = excluded.lock_pid,
         lock_started_at = excluded.lock_started_at,
         heartbeat_at = excluded.heartbeat_at`,
    )
    .run(args.id, args.display_name, args.host, args.cwd, args.pid, args.nowIso, args.nowIso)
  return storage.db.query('SELECT * FROM sessions WHERE id = ?').get(args.id) as SessionRow
}

/** Clear the lock_pid for a session at clean shutdown. Row history is
 *  preserved so threads / message history remain queryable. */
export function clearSessionLock(storage: Storage, sessionId: string): void {
  storage.db
    .query('UPDATE sessions SET lock_pid = NULL, lock_started_at = NULL WHERE id = ?')
    .run(sessionId)
}

/** Update heartbeat + ambient state from a periodic shim heartbeat.
 *  Conditional on the session still having an active lock — a
 *  heartbeat arriving after deregister (e.g. the shim's heartbeat
 *  interval racing the shim's own shutdown) MUST NOT resurrect the
 *  lock_pid and turn a deregistered session back into "alive" for
 *  peer enumeration. Returns true iff the update affected a row. */
export function recordHeartbeat(
  storage: Storage,
  args: {
    session_id: string
    pid: number
    agent_status: string | null
    agent_intent: string | null
    nowIso: string
  },
): boolean {
  const result = storage.db
    .query(
      `UPDATE sessions SET
         heartbeat_at = ?,
         lock_pid = ?,
         agent_status = COALESCE(?, agent_status),
         agent_intent = COALESCE(?, agent_intent)
       WHERE id = ? AND lock_pid IS NOT NULL`,
    )
    .run(args.nowIso, args.pid, args.agent_status, args.agent_intent, args.session_id)
  return result.changes > 0
}

/* --- Pending-notifications queue (used by Phase 3) --------------------- */

export const PENDING_PER_SESSION_CAP = 1024

/** Buffer one notification for a session whose shim is currently
 *  offline. Trims the queue to {@link PENDING_PER_SESSION_CAP} oldest
 *  rows per session_id so a long-offline peer can't grow unbounded. */
export function enqueuePendingNotification(
  storage: Storage,
  args: { session_id: string; method: string; params: unknown; nowIso: string },
): void {
  storage.db
    .query(
      `INSERT INTO pending_notifications (session_id, method, params_json, enqueued_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(args.session_id, args.method, JSON.stringify(args.params), args.nowIso)
  storage.db
    .query(
      `DELETE FROM pending_notifications WHERE session_id = ? AND id NOT IN (
         SELECT id FROM pending_notifications WHERE session_id = ?
           ORDER BY id DESC LIMIT ?
       )`,
    )
    .run(args.session_id, args.session_id, PENDING_PER_SESSION_CAP)
}

/** Drain (read + delete) every pending notification for a session.
 *  Called by the register handler so the shim receives buffered
 *  events as part of its handshake response. */
export function drainPendingNotifications(
  storage: Storage,
  sessionId: string,
): { method: string; params: unknown }[] {
  const rows = storage.db
    .query(
      `SELECT id, method, params_json FROM pending_notifications
       WHERE session_id = ? ORDER BY id ASC`,
    )
    .all(sessionId) as { id: number; method: string; params_json: string }[]
  if (rows.length === 0) return []
  storage.db.query('DELETE FROM pending_notifications WHERE session_id = ?').run(sessionId)
  return rows.map(r => ({ method: r.method, params: JSON.parse(r.params_json) }))
}
