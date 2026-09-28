-- Multi-session support (up to four live sessions per technician).
--
-- 1. The per-account concurrent-session limit now defaults to 4, the same as the
--    server-wide ceiling MAX_CONCURRENT_SESSIONS_PER_AGENT. Accounts still on
--    the old default of 3 move to 4; any other value an administrator chose is
--    kept (the relay enforces min(account limit, ceiling) either way).
ALTER TABLE users ALTER COLUMN max_concurrent_sessions SET DEFAULT 4;
UPDATE users SET max_concurrent_sessions = 4, updated_at = now() WHERE max_concurrent_sessions = 3;

-- 2. Technician-side reconnect. A dropped technician socket no longer ends the
--    session at once; these record how often that happened and why the last
--    drop occurred (a stable code, never free text from a client).
ALTER TABLE sessions ADD COLUMN reconnect_count        integer NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN last_disconnect_reason text;
ALTER TABLE sessions ADD COLUMN last_disconnect_at     timestamptz;

-- 3. "Which sessions does this technician have open right now" — the admin
--    portal's per-technician view and restart reconciliation both ask it.
CREATE INDEX sessions_org_agent_status_idx ON sessions (org_id, agent_user_id, status);
