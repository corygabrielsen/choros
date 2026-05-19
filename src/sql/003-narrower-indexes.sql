-- Migration 003 — narrow + covering indexes for the hot read paths.
--
-- Partial index: every broadcast + isLive + doctor check filters by
-- `lock_pid IS NOT NULL`. The default `sessions_heartbeat` index
-- includes every historical row even when the lock is null —
-- restricting the index to live rows shrinks both the index size
-- and the scan range when listing live peers.
CREATE INDEX IF NOT EXISTS sessions_heartbeat_live
  ON sessions(heartbeat_at DESC)
  WHERE lock_pid IS NOT NULL;

-- Covering index for doctor's inbox_unread count:
--   SELECT COUNT(*) FROM messages
--     WHERE to_session = ? AND delivered_at IS NULL AND read_at IS NULL
-- Old `messages_to (to_session, delivered_at)` was non-covering on
-- read_at, forcing per-row table fetch. Widening to all three
-- filter columns makes this an index-only scan.
CREATE INDEX IF NOT EXISTS messages_inbox_unread
  ON messages(to_session, delivered_at, read_at);
