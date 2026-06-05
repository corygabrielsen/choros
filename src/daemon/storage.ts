import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SQL_DIR = `${HERE}/../sql`

/** Current schema version the daemon binary expects. `applyMigrations`
 *  brings any older database up to this number. Bump when adding a new
 *  migration file `src/sql/NNN-*.sql`. */
export const SCHEMA_VERSION = 5

/** Ordered migration files. Each is applied if and only if the current
 *  `system_meta.schema_version` is below the file's target version.
 *  Files are read at module load so the daemon binary embeds them. */
const MIGRATIONS: { version: number; sql: string }[] = [
  { version: 1, sql: readFileSync(`${SQL_DIR}/000-init.sql`, 'utf8') },
  { version: 2, sql: readFileSync(`${SQL_DIR}/001-display-name-index.sql`, 'utf8') },
  { version: 3, sql: readFileSync(`${SQL_DIR}/002-hot-path-indexes.sql`, 'utf8') },
  { version: 4, sql: readFileSync(`${SQL_DIR}/003-narrower-indexes.sql`, 'utf8') },
  { version: 5, sql: readFileSync(`${SQL_DIR}/004-inbox-order-index.sql`, 'utf8') },
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
 *  handlers' writes). Auto-checkpoint at 1000 frames keeps the WAL
 *  bounded under sustained writes. */
export function openStorage(path: string): Storage {
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA wal_autocheckpoint = 1000')
  // Block instead of throw on a transient writer lock contended by
  // the admin HTTP read path. 5s comfortably covers any single-txn
  // handler; longer than that is a wedge worth surfacing as an error.
  db.exec('PRAGMA busy_timeout = 5000')
  // Foreign keys are NOT enforced: `messages.from_session` and
  // `messages.to_session` intentionally accept session ids that may
  // not yet exist in `sessions` (peers come and go). Declared
  // constraints would reject those writes. The previous
  // `PRAGMA foreign_keys = ON` was misleading because no FK
  // relationships were declared in 000-init.sql.
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
 *  handler. Returns the row as it now exists in the DB via the
 *  `RETURNING *` clause — one statement instead of insert-then-
 *  select. */
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
  return storage.db
    .query(
      `INSERT INTO sessions (id, display_name, host, cwd, lock_pid, lock_started_at, heartbeat_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         display_name = excluded.display_name,
         host = excluded.host,
         cwd = excluded.cwd,
         lock_pid = excluded.lock_pid,
         lock_started_at = excluded.lock_started_at,
         heartbeat_at = excluded.heartbeat_at
       RETURNING *`,
    )
    .get(
      args.id,
      args.display_name,
      args.host,
      args.cwd,
      args.pid,
      args.nowIso,
      args.nowIso,
    ) as SessionRow
}

/** Upsert identity metadata without claiming a live notification lock.
 *  Tool-only adapters use this to authenticate daemon calls for a
 *  session while a separate process owns push delivery. */
export function upsertSessionMetadata(
  storage: Storage,
  args: {
    id: string
    display_name: string | null
    host: string
    cwd: string
  },
): SessionRow {
  return storage.db
    .query(
      `INSERT INTO sessions (id, display_name, host, cwd, lock_pid, lock_started_at, heartbeat_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL)
       ON CONFLICT(id) DO UPDATE SET
         display_name = excluded.display_name,
         host = excluded.host,
         cwd = excluded.cwd
       RETURNING *`,
    )
    .get(args.id, args.display_name, args.host, args.cwd) as SessionRow
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
 *  offline. Trims the queue to keep the NEWEST {@link
 *  PENDING_PER_SESSION_CAP} rows per session_id so a long-offline
 *  peer can't grow the table unbounded. Newest-wins is correct for
 *  this surface because a long-offline peer cares more about recent
 *  events than ancient ones. The trim is gated by an OFFSET probe so
 *  the typical case (offline peer with < cap pending rows) skips the
 *  DELETE entirely. */
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
  // Gate the trim: only run it if a row exists past the cap. The
  // SELECT short-circuits as soon as it finds row #(cap+1), so cost
  // is O(cap+1) at worst — and zero past the first index seek when
  // the queue is below cap.
  const overflow = storage.db
    .query('SELECT 1 FROM pending_notifications WHERE session_id = ? LIMIT 1 OFFSET ?')
    .get(args.session_id, PENDING_PER_SESSION_CAP) as { 1: number } | null
  if (!overflow) return
  storage.db
    .query(
      `DELETE FROM pending_notifications WHERE session_id = ? AND id NOT IN (
         SELECT id FROM pending_notifications WHERE session_id = ?
           ORDER BY id DESC LIMIT ?
       )`,
    )
    .run(args.session_id, args.session_id, PENDING_PER_SESSION_CAP)
}

/** Max notifications drained into a single register response. Prevents
 *  a long-offline peer from getting a multi-MB drain frame that
 *  blocks the shim's event loop on JSON.parse + a thousand
 *  synchronous mcp.notification re-emits. Excess rows stay in the
 *  table for the NEXT drain (which can be triggered by a follow-up
 *  no-op register, or — TODO — a dedicated drain RPC). */
export const PENDING_DRAIN_MAX = 256

/** Drain pending notifications for a session in insertion (FIFO) order.
 *  Caller (register) replays them BEFORE live traffic so ordering is
 *  preserved across reconnect.
 *
 *  We DELETE inside a transaction by id-range from the FIFO-ordered
 *  SELECT, so `RETURNING` order (which SQLite does not promise) can't
 *  scramble the backlog. A row with a corrupt `params_json` is logged
 *  and skipped rather than aborting the entire drain — historically
 *  `DELETE … RETURNING` would silently nuke the rest of the backlog
 *  on the throwing JSON.parse. */
export function drainPendingNotifications(
  storage: Storage,
  sessionId: string,
): { method: string; params: unknown }[] {
  const rows = storage.db
    .query(
      `SELECT id, method, params_json FROM pending_notifications
       WHERE session_id = ?
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(sessionId, PENDING_DRAIN_MAX) as {
    id: number
    method: string
    params_json: string
  }[]
  if (rows.length === 0) return []
  const ids = rows.map(r => r.id)
  const placeholders = ids.map(() => '?').join(',')
  storage.db.query(`DELETE FROM pending_notifications WHERE id IN (${placeholders})`).run(...ids)
  const drained: { method: string; params: unknown }[] = []
  for (const r of rows) {
    try {
      drained.push({ method: r.method, params: JSON.parse(r.params_json) })
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e)
      process.stderr.write(
        `[choros-daemon] dropping malformed pending notification id=${r.id} session=${sessionId}: ${m}\n`,
      )
    }
  }
  return drained
}
