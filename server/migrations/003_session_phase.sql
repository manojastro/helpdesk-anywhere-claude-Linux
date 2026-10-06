-- Technician Platform 2.0, Phase 1: explicit session lifecycle phase.
--
-- `sessions.status` (waiting_for_customer | waiting_for_consent | active | ended)
-- is unchanged and still drives every existing query. `phase` is the validated
-- lifecycle state from `server/src/lifecycle.ts`, kept current by the relay; each
-- change is also a `session.phase` row in `session_events` with its timestamp.
--
-- Forward-only like 001/002. To roll back by hand:
--   ALTER TABLE sessions DROP COLUMN phase, DROP COLUMN phase_changed_at;
--   DELETE FROM session_events WHERE type = 'session.phase';
--   DELETE FROM schema_migrations WHERE version = '003_session_phase.sql';

ALTER TABLE sessions ADD COLUMN phase text;
ALTER TABLE sessions ADD COLUMN phase_changed_at timestamptz;

-- Existing rows. Restart reconciliation runs after migrations, so nothing is
-- live here; anything not ended gets ENDED and is reconciled moments later.
UPDATE sessions SET
  phase = CASE
    WHEN consent_decision = 'declined' THEN 'DECLINED'
    WHEN end_reason = 'code_expired' THEN 'EXPIRED'
    WHEN end_reason = 'storage_unavailable' THEN 'FAILED'
    ELSE 'ENDED'
  END,
  phase_changed_at = COALESCE(ended_at, created_at);

ALTER TABLE sessions ALTER COLUMN phase SET DEFAULT 'CREATED';
ALTER TABLE sessions ALTER COLUMN phase SET NOT NULL;
ALTER TABLE sessions ALTER COLUMN phase_changed_at SET DEFAULT now();
ALTER TABLE sessions ADD CONSTRAINT sessions_phase_check CHECK (phase IN (
  'CREATED', 'WAITING', 'CONSENT_PENDING', 'CONNECTED', 'CONTROLLING', 'ON_HOLD',
  'RECONNECTING', 'ENDED', 'EXPIRED', 'DECLINED', 'FAILED'
));

-- "Completed today" and per-technician recent history on the console dashboard.
CREATE INDEX sessions_org_agent_ended_idx ON sessions (org_id, agent_user_id, ended_at DESC);
