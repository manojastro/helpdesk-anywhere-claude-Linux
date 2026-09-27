-- Helpdesk Anywhere — durable records (admin portal, Entra ID, session history).
--
-- Every row that belongs to a customer organisation carries org_id, even though the
-- first release accepts exactly one configured Entra tenant. Every query in
-- server/src filters on it; nothing relies on there being only one.
--
-- What is deliberately NOT stored anywhere in this schema:
--   * the six-digit pairing code (a short-lived secret, not an identifier);
--   * credential-mode elevation payloads (never leave the relay's frame);
--   * OIDC tokens and raw session cookies (auth_sessions stores a SHA-256 only);
--   * script bodies (session_events keeps shell, size and SHA-256 — the JSONL
--     security audit keeps the full text, as PLAN 1.6 requires);
--   * screen content of any kind. There is no recording.

CREATE TABLE organizations (
  id               uuid PRIMARY KEY,
  entra_tenant_id  text NOT NULL UNIQUE,
  name             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name),
  UNIQUE (org_id, id)
);

-- One row per Entra identity that has ever signed in. The stable key is
-- (tenant id, object id) — never the e-mail address, which is mutable and
-- re-assignable.
CREATE TABLE users (
  id                       uuid PRIMARY KEY,
  org_id                   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entra_tenant_id          text NOT NULL,
  entra_object_id          text NOT NULL,
  display_name             text NOT NULL,
  email                    text,
  -- App roles seen in the most recent verified ID token. Empty means the person
  -- signed in but is not assigned to the application in Entra.
  entra_roles              text[] NOT NULL DEFAULT '{}',
  status                   text NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'active', 'suspended')),
  agent_code               text CHECK (agent_code IS NULL OR agent_code ~ '^[A-Za-z0-9._-]{1,32}$'),
  team_id                  uuid,
  -- Application-level limits, applied on top of (never beyond) the Entra role.
  can_use_console          boolean NOT NULL DEFAULT true,
  allow_scripts            boolean NOT NULL DEFAULT true,
  allow_elevation          boolean NOT NULL DEFAULT true,
  can_export               boolean NOT NULL DEFAULT true,
  max_concurrent_sessions  integer NOT NULL DEFAULT 3 CHECK (max_concurrent_sessions BETWEEN 1 AND 20),
  status_reason            text,
  status_changed_at        timestamptz,
  status_changed_by        uuid REFERENCES users(id),
  first_seen_at            timestamptz NOT NULL DEFAULT now(),
  last_login_at            timestamptz,
  -- Console heartbeat; "agents online" is defined over this column.
  last_heartbeat_at        timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entra_tenant_id, entra_object_id),
  UNIQUE (org_id, agent_code),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, team_id) REFERENCES teams (org_id, id)
);
CREATE INDEX users_org_status_idx    ON users (org_id, status);
CREATE INDEX users_org_heartbeat_idx ON users (org_id, last_heartbeat_at);

-- Server-side browser sessions. id_hash is SHA-256 of the cookie value; the value
-- itself exists only in the browser.
CREATE TABLE auth_sessions (
  id_hash       bytea PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  csrf_token    text NOT NULL,
  entra_roles   text[] NOT NULL,
  auth_method   text NOT NULL CHECK (auth_method IN ('entra', 'dev')),
  -- Which application issued it. An agent-console session is never accepted by
  -- the admin portal, and vice versa: two apps, two sign-ins.
  portal        text NOT NULL CHECK (portal IN ('agent', 'admin')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  ip            text,
  user_agent    text
);
CREATE INDEX auth_sessions_user_idx    ON auth_sessions (user_id);
CREATE INDEX auth_sessions_expires_idx ON auth_sessions (expires_at);

-- One row per support session. id is the permanent identifier used everywhere
-- (history, reports, links); the pairing code is not stored.
CREATE TABLE sessions (
  id                    uuid PRIMARY KEY,
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_user_id         uuid NOT NULL,
  -- Snapshots at creation time, so history survives renames and team moves.
  team_id               uuid,
  agent_display_name    text NOT NULL,
  agent_code            text,
  status                text NOT NULL
                          CHECK (status IN ('waiting_for_customer', 'waiting_for_consent', 'active', 'ended')),
  end_reason            text,
  consent_decision      text CHECK (consent_decision IN ('accepted', 'declined')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  code_expires_at       timestamptz,
  customer_joined_at    timestamptz,
  consent_decided_at    timestamptz,
  active_at             timestamptz,
  ended_at              timestamptz,
  customer_machine      text,
  customer_user         text,
  customer_os           text,
  customer_ip           text,
  -- False when any timeline/chat write for this session failed: the record is
  -- then visibly incomplete rather than silently so.
  record_complete       boolean NOT NULL DEFAULT true,
  persist_failures      integer NOT NULL DEFAULT 0,
  transcript_purged_at  timestamptz,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, agent_user_id) REFERENCES users (org_id, id),
  FOREIGN KEY (org_id, team_id) REFERENCES teams (org_id, id)
);
CREATE INDEX sessions_org_created_idx       ON sessions (org_id, created_at DESC);
CREATE INDEX sessions_org_agent_created_idx ON sessions (org_id, agent_user_id, created_at DESC);
CREATE INDEX sessions_org_team_created_idx  ON sessions (org_id, team_id, created_at DESC);
CREATE INDEX sessions_org_status_idx        ON sessions (org_id, status);
CREATE INDEX sessions_org_ended_idx         ON sessions (org_id, ended_at);
CREATE INDEX sessions_org_machine_idx       ON sessions (org_id, lower(customer_machine));

-- The ordered, server-generated timeline. seq is assigned by the relay in the
-- order things happened, not in the order the database acknowledged them.
CREATE TABLE session_events (
  session_id     uuid NOT NULL,
  seq            integer NOT NULL,
  org_id         uuid NOT NULL,
  type           text NOT NULL,
  at             timestamptz NOT NULL DEFAULT now(),
  actor_role     text NOT NULL CHECK (actor_role IN ('agent', 'customer', 'system', 'admin')),
  actor_user_id  uuid,
  detail         jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (org_id, session_id) REFERENCES sessions (org_id, id) ON DELETE CASCADE
);
CREATE INDEX session_events_org_type_idx ON session_events (org_id, type, at DESC);

-- Canonical chat transcript. A retried message (same client id from the same
-- side) hits the unique constraint and is answered with the stored row.
CREATE TABLE chat_messages (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL,
  session_id      uuid NOT NULL,
  seq             integer NOT NULL,
  sender_role     text NOT NULL CHECK (sender_role IN ('agent', 'customer')),
  sender_user_id  uuid,
  kind            text NOT NULL CHECK (kind IN ('text', 'url')),
  body            text,
  url             text,
  label           text,
  client_msg_id   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq),
  UNIQUE (session_id, sender_role, client_msg_id),
  FOREIGN KEY (org_id, session_id) REFERENCES sessions (org_id, id) ON DELETE CASCADE
);

-- Technician-private notes, one row per save (latest wins in the UI; earlier
-- revisions stay for the record). Never sent to the customer.
CREATE TABLE session_notes (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL,
  session_id      uuid NOT NULL,
  author_user_id  uuid NOT NULL,
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, session_id) REFERENCES sessions (org_id, id) ON DELETE CASCADE
);
CREATE INDEX session_notes_session_idx ON session_notes (session_id, created_at);

CREATE TABLE report_exports (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by    uuid NOT NULL REFERENCES users(id),
  kind            text NOT NULL CHECK (kind IN ('session_pdf', 'summary_csv')),
  session_id      uuid,
  params          jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'ready', 'failed', 'expired')),
  content         bytea,
  content_type    text,
  filename        text,
  byte_size       integer,
  error           text,
  download_count  integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  ready_at        timestamptz,
  expires_at      timestamptz NOT NULL
);
CREATE INDEX report_exports_org_created_idx ON report_exports (org_id, created_at DESC);
CREATE INDEX report_exports_requester_idx   ON report_exports (requested_by, created_at DESC);

-- Administrative audit trail: access changes, transcript/notes views, report
-- exports and downloads, sign-ins, terminations. The relay's own security log
-- (session lifecycle, elevation, scripts) stays in the JSONL files.
CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  org_id         uuid REFERENCES organizations(id) ON DELETE CASCADE,
  at             timestamptz NOT NULL DEFAULT now(),
  actor_user_id  uuid REFERENCES users(id),
  actor_label    text,
  action         text NOT NULL,
  target_type    text,
  target_id      text,
  detail         jsonb NOT NULL DEFAULT '{}',
  ip             text
);
CREATE INDEX audit_log_org_at_idx     ON audit_log (org_id, at DESC);
CREATE INDEX audit_log_org_action_idx ON audit_log (org_id, action, at DESC);
