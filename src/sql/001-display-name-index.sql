-- Migration 001 — index resolveRecipient's by-name hot path.
--
-- send / broadcast / publish all resolve recipients via display_name
-- match before the UUID-prefix fallback. Without this index the
-- query scans the full sessions table on every send. NOCASE makes
-- display-name resolution case-insensitive, matching the topic
-- canonicalization model.
CREATE INDEX IF NOT EXISTS sessions_display_name ON sessions(display_name COLLATE NOCASE);
