-- Technician Platform 2.0, Phase 2: saved script library.
--
-- Organisation scripts, managed by administrators in the admin portal. Built-in
-- scripts ship in code (`server/src/scriptLibrary.ts`) and are not stored here.
-- A script is never edited in place: every save writes a new version row and
-- the old one stays, so a timeline entry "ran script X v3" always resolves to
-- the exact text that ran (the relay also records its SHA-256).
--
-- Forward-only. To roll back by hand:
--   DROP TABLE script_library;
--   DELETE FROM schema_migrations WHERE version = '004_script_library.sql';

CREATE TABLE script_library (
  id              uuid NOT NULL,
  version         integer NOT NULL CHECK (version >= 1),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description     text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  category        text NOT NULL CHECK (char_length(category) BETWEEN 1 AND 60),
  shell           text NOT NULL CHECK (shell IN ('powershell', 'cmd')),
  body            text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
  -- 'user': runs as the signed-in customer; 'system': needs an elevated session
  -- and runs as SYSTEM through the existing elevated service.
  run_as          text NOT NULL CHECK (run_as IN ('user', 'system')),
  created_by      uuid,
  created_by_name text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Set on the version that was current when the script was archived; an
  -- archived script is hidden from technicians and kept for the record.
  archived_at     timestamptz,
  PRIMARY KEY (id, version)
);
CREATE INDEX script_library_org_idx ON script_library (org_id, id, version DESC);
