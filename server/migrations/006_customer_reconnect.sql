-- Technician Platform 2.0, Phase 3: customer-side reconnect.
--
-- 1. The lifecycle gains DISCONNECTED (the customer's applet lost its connection
--    and may resume within HOST_RECONNECT_GRACE_MS).
-- 2. How often that happened, on the record.
--
-- Forward-only. To roll back by hand: restore the previous CHECK constraint
-- (see 003), DROP COLUMN host_reconnect_count, delete the schema_migrations row.

ALTER TABLE sessions DROP CONSTRAINT sessions_phase_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_phase_check CHECK (phase IN (
  'CREATED', 'WAITING', 'CONSENT_PENDING', 'CONNECTED', 'CONTROLLING', 'ON_HOLD',
  'RECONNECTING', 'DISCONNECTED', 'ENDED', 'EXPIRED', 'DECLINED', 'FAILED'
));
ALTER TABLE sessions ADD COLUMN host_reconnect_count integer NOT NULL DEFAULT 0;
