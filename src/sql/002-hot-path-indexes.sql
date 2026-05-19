-- Migration 002 — fix the two index gaps perf-r5 surfaced.
--
-- publish() hot path:
--   SELECT session_id FROM subscriptions WHERE topic = ? AND session_id != ?
-- The PK is (session_id, topic), so a topic-keyed query can't use it.
-- Without this index every publish seq-scans subscriptions.
CREATE INDEX IF NOT EXISTS subscriptions_topic ON subscriptions(topic, session_id);

-- list_threads + send_to_thread hot path:
--   SELECT thread_id, MAX(ts) FROM messages WHERE thread_id IS NOT NULL GROUP BY thread_id
--   SELECT ... FROM messages WHERE thread_id = ? ORDER BY ts ASC
-- A composite (thread_id, ts) lets SQLite resolve both queries via
-- index-only scans for the per-thread MAX and the ordered backlog.
CREATE INDEX IF NOT EXISTS messages_thread_ts ON messages(thread_id, ts);
