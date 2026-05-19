-- choros daemon schema v1
--
-- Replaces the filesystem-as-state-store model with SQLite + WAL.
-- Every read-modify-write race the bug-hunt found becomes an
-- INSERT … ON CONFLICT DO UPDATE or a UNIQUE-constraint violation.
--
-- All times are ISO-8601 strings (UTC). Daemon writes them via
-- ctx.clock.nowIso() / SQLite's strftime; tests use FakeClock.

CREATE TABLE IF NOT EXISTS system_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  display_name    TEXT,
  host            TEXT,
  cwd             TEXT,
  -- Process-side identity. lock_pid being NULL means "this session has
  -- no live shim attached"; the daemon may still have rows about it
  -- (history, threads).
  lock_pid        INTEGER,
  lock_started_at TEXT,
  heartbeat_at    TEXT,
  -- Agent ambient state (was .agent_state on disk). Updated via
  -- choros.set_status / choros.set_intent; surfaced in doctor.
  agent_status    TEXT,
  agent_intent    TEXT,
  -- Wedge bookkeeping (was .wedged on disk).
  wedged_at       TEXT,
  wedge_pending   TEXT             -- JSON array of msg_ids
);
CREATE INDEX IF NOT EXISTS sessions_heartbeat ON sessions(heartbeat_at);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  from_session    TEXT NOT NULL,
  to_session      TEXT,            -- NULL for broadcast/publish messages
  topic           TEXT,            -- non-NULL for publish
  thread_id       TEXT,
  in_reply_to     TEXT,
  body            TEXT NOT NULL,
  act             TEXT,            -- speech-act enum value or NULL
  mentions        TEXT,            -- JSON array of session ids
  broadcast       INTEGER NOT NULL DEFAULT 0,  -- 0/1
  ts              TEXT NOT NULL,
  -- Delivery lifecycle. Initially all NULL. delivered_at is set when
  -- the recipient's shim JSONL-confirms; dropped_at is set when the
  -- JSONL probe misses. read_at is set when /choros read archives.
  delivered_at    TEXT,
  dropped_at      TEXT,
  read_at         TEXT
);
CREATE INDEX IF NOT EXISTS messages_to     ON messages(to_session, delivered_at);
CREATE INDEX IF NOT EXISTS messages_topic  ON messages(topic);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS messages_from   ON messages(from_session);

CREATE TABLE IF NOT EXISTS subscriptions (
  session_id  TEXT NOT NULL,
  topic       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (session_id, topic)
);

CREATE TABLE IF NOT EXISTS threads (
  root_msg_id  TEXT PRIMARY KEY,
  title        TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_members (
  thread_id    TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  joined_at    TEXT NOT NULL,
  PRIMARY KEY (thread_id, session_id)
);

CREATE TABLE IF NOT EXISTS reactions (
  msg_id       TEXT NOT NULL,
  by_session   TEXT NOT NULL,
  emoji        TEXT NOT NULL,
  reacted_at   TEXT NOT NULL,
  -- (msg_id, by_session) keying means a peer reacting twice to the
  -- same message UPSERTs in place rather than colliding on the
  -- on-disk filename like the pre-v1 model did.
  PRIMARY KEY (msg_id, by_session)
);

-- Queue of notifications buffered for sessions that aren't currently
-- connected. Flushed in insertion order when their shim re-registers.
-- Bounded — daemon trims by per-session row count on insert.
CREATE TABLE IF NOT EXISTS pending_notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  method        TEXT NOT NULL,
  params_json   TEXT NOT NULL,
  enqueued_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_notifications_session ON pending_notifications(session_id, id);

INSERT OR IGNORE INTO system_meta(key, value) VALUES ('schema_version', '1');
