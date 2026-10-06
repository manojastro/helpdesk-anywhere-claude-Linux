-- Technician Platform 2.0, Phase 5: session transfer between technicians.
--
-- One row per offer. A session's owner (sessions.agent_user_id) changes only
-- when a transfer completes — after the receiving technician accepted AND the
-- customer approved the new technician (DECISIONS.md D-020).
--
-- Forward-only. To roll back by hand:
--   DROP TABLE session_transfers;
--   DELETE FROM schema_migrations WHERE version = '007_session_transfer.sql';

CREATE TABLE session_transfers (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  session_id    uuid NOT NULL,
  from_user_id  uuid,
  from_name     text NOT NULL,
  to_user_id    uuid,
  to_name       text NOT NULL,
  note          text CHECK (note IS NULL OR char_length(note) <= 500),
  status        text NOT NULL CHECK (status IN (
                  'offered', 'awaiting_customer', 'completed', 'declined_by_technician',
                  'declined_by_customer', 'expired', 'cancelled', 'failed')),
  detail        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  FOREIGN KEY (org_id, session_id) REFERENCES sessions (org_id, id) ON DELETE CASCADE
);
CREATE INDEX session_transfers_session_idx ON session_transfers (org_id, session_id, created_at);
CREATE INDEX session_transfers_from_idx ON session_transfers (org_id, from_user_id, created_at DESC);
