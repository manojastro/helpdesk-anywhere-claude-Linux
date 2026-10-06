-- Technician Platform 2.0, Phase 2b: file transfer and file manager.
--
-- 1. A per-technician limit, like allow_scripts: an administrator can switch
--    file access (browse, upload, download, create, rename, delete) off for an
--    account. Defaults on, as scripts do.
-- 2. One row per transfer: who moved what, which way, how big, where, and how it
--    ended. File CONTENTS are never stored anywhere — the relay only passes
--    chunks through.
--
-- Forward-only. To roll back by hand:
--   DROP TABLE file_transfers; ALTER TABLE users DROP COLUMN allow_file_transfer;
--   DELETE FROM schema_migrations WHERE version = '005_file_transfer.sql';

ALTER TABLE users ADD COLUMN allow_file_transfer boolean NOT NULL DEFAULT true;

CREATE TABLE file_transfers (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  session_id    uuid NOT NULL,
  user_id       uuid,
  direction     text NOT NULL CHECK (direction IN ('upload', 'download')),
  file_name     text NOT NULL,
  remote_path   text,
  size_bytes    bigint NOT NULL CHECK (size_bytes >= 0),
  bytes_done    bigint NOT NULL DEFAULT 0,
  status        text NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed', 'cancelled')),
  error         text,
  sha256        text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  FOREIGN KEY (org_id, session_id) REFERENCES sessions (org_id, id) ON DELETE CASCADE
);
CREATE INDEX file_transfers_session_idx ON file_transfers (org_id, session_id, started_at);
