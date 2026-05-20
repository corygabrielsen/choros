-- Migration 004 — make the inbox pull index-ordered.
--
-- handleInbox filters `to_session = ? AND read_at IS NULL` and orders by
-- `ts, id`. The migration-003 messages_inbox_unread index
-- (to_session, delivered_at, read_at) only serves the leading
-- to_session here — read_at is unreachable past the skipped delivered_at
-- column, and ts/id aren't in it — so the planner adds a TEMP B-TREE
-- sort on every pull (EXPLAIN-confirmed). A partial index keyed on the
-- exact filter + sort columns makes it a plain index range scan.
-- messages_inbox_unread stays: it covers doctor's unread COUNT.
CREATE INDEX IF NOT EXISTS messages_unread_order
  ON messages(to_session, ts, id)
  WHERE read_at IS NULL;
