# Admin portal, identity and durable records

Reference for the admin-portal release. Setup: `docs/ENTRA_SETUP.md`.
Deployment, backups, subdomains: `docs/OPERATIONS.md`. Decisions: `DECISIONS.md`
D-014 … D-017.

## 1. What changed, in one paragraph

Technicians and administrators now sign in with Microsoft Entra ID, and an
Entra app role **plus** an active application record is required for access. The
**technician console** (`app.<domain>`) and the new **admin portal**
(`admin.<domain>`) are two separate applications — separate frontends, entry
points, listeners, cookies, sign-ins and API prefixes — served by the one
existing Node/TypeScript process, which still hosts the only relay. PostgreSQL
is the system of record for sessions, the ordered timeline, chat transcripts,
private notes, people, report exports and the administrative audit trail. The
Windows applet and its verified privileged-control architecture are unchanged;
its one visible change is a line in the chat window saying chat is saved.

## 2. Guarantees preserved

| Guarantee | Where it still holds |
|---|---|
| Consent before anything streams | `signaling.ts` — unchanged gate: nothing relayed before `state === "active"`; ws/01, ws/04 |
| Indicator + one-click end | Applet unchanged (`IndicatorForm`); End Session is now recorded as `customer_ended` |
| One-shot applet, no persistence | Applet unchanged; source/15, source/25 (golden diff) |
| Credentials never retained | Elevation frame forwarded verbatim, synchronously, before any DB work; the timeline stores the mode only; api/33 greps every table, the JSONL log, the server output and the PDF for the password |
| Server-enforced pre-consent gate | Unchanged; now also: no session without a signed-in, active, permitted technician |
| Golden Windows checkpoint | `source/25` fails if any privileged component differs from `hda-windows-privileged-control-working-2026-09-06` |

## 3. Identity and access

* **Stable identity** = Entra tenant ID + object ID (`oid`). E-mail is display only.
* **Roles** (Entra app roles): `Admin`, `Supervisor`, `Agent`, `Auditor`
  (matrix in `docs/ENTRA_SETUP.md` §4, code in `server/src/auth/permissions.ts`).
* **Effective access** requires (a) an eligible role in the verified ID token,
  (b) `users.status = 'active'`, (c) for the console, `can_use_console`; for
  the admin portal, one of Admin/Supervisor/Auditor.
* **Lifecycle**: first sign-in → `pending` (no access) → an Admin sets the
  internal **agent ID** and **team** and activates → `active`. Suspend /
  reactivate at any time. No role in the token → recorded, shown as
  "Assignment required in Entra", never admitted.
* **Per-user limits** (narrow the role, never widen it): console use, remote
  scripts, elevation requests, report export, max concurrent sessions (1–20,
  default 3). Enforced on the WebSocket and the API.
* **Bootstrap**: `BOOTSTRAP_ADMIN_OIDS` + Admin role + no active admin yet.
* **Revocation**: suspension deletes the person's browser sessions and closes
  their live sockets immediately (their live sessions end as
  `agent_access_revoked`). Entra removal takes effect at next sign-in; sign-ins
  last at most `AUTH_MAX_HOURS` (12) / `AUTH_IDLE_MINUTES` (120) idle.
* **Browser sessions**: 32 random bytes in a `__Host-` cookie; the database
  stores SHA-256 only; CSRF token per session; each request re-reads the user.
* **Development sign-in** (`AUTH_MODE=dev`): a form accepting any identity,
  for loopback development and the test suite. Fatal at startup under
  `NODE_ENV=production` (set in the Docker image), on a non-loopback host, or
  behind a trusted proxy; compose pins `AUTH_MODE=entra`; in Entra mode the
  route is not registered at all (api/34).

## 4. Data model (`server/migrations/001_init.sql`)

| Table | Holds | Never holds |
|---|---|---|
| `organizations` | one row per Entra tenant | |
| `teams` | name per org | |
| `users` | Entra identity, roles last seen, status, agent ID, team, limits, heartbeat | passwords |
| `auth_sessions` | SHA-256 of cookie, CSRF token, portal, expiry | the cookie, OIDC tokens |
| `sessions` | UUID, owner snapshot (name, agent ID, team), status, consent, times, device info, end reason, `record_complete` | the pairing code |
| `session_events` | ordered timeline `(session_id, seq)` with safe detail | script text or output, credentials, account names |
| `chat_messages` | canonical transcript, `(session_id, seq)`, unique `(session_id, sender_role, client_msg_id)` | |
| `session_notes` | one row per save (revisions kept) | |
| `report_exports` | request, status, file bytes until the TTL, download count | |
| `audit_log` | access changes, sign-ins, transcript/notes views, report requests/downloads/denials, terminations, retention purges | chat content |

Every table carries `org_id`; composite foreign keys keep child rows in their
session's organisation. Every query in `server/src` filters on the caller's
organisation first (`sessionScopeSql`), then narrows by role.

Indexes: sessions by (org, created), (org, agent, created), (org, team,
created), (org, status), (org, ended), (org, lower(machine)); audit by (org, at)
and (org, action, at); users by (org, status) and (org, heartbeat).

## 5. Session lifecycle and timeline

The six-digit code is the pairing secret; `sessions.id` (UUID, returned to the
console as `session.created.sessionId`) is the identifier everywhere else.

Timeline event types, in the order they typically occur:
`session.created` (code issued, TTL) · `customer.joined` · `consent.requested` ·
`consent.accepted` / `consent.declined` · `session.active` · `session.held` /
`session.resumed` · `desktop.changed` (Secure Desktop shown/left) ·
`elevation.requested` / `elevation.refused` / `elevation.result` ·
`script.requested` (shell, bytes, SHA-256) / `script.refused` / `script.result`
(exit code) · `sas.sent` · `url.shared` (domain only) · `notes.saved` (length) ·
`agent.disconnected` / `customer.disconnected` · `session.ended` (reason) ·
`session.interrupted` (restart reconciliation).

End reasons: `agent_ended`, `customer_ended` (applet End Session),
`customer_declined`, `agent_disconnected`, `customer_disconnected`,
`code_expired`, `terminated_by_admin`, `agent_access_revoked`,
`agent_session_expired`, `storage_unavailable`, `server_shutdown`,
`server_restart`.

**Ordering**: each live session has its own write queue; sequence numbers are
assigned synchronously when the relay observes the event.

**Failure policy**:

| Write | If the database write fails |
|---|---|
| Session creation | No code is issued; `storage_unavailable` |
| Chat message | Not delivered; sender gets `chat_not_saved` (retry-safe) |
| Script request | Script not forwarded; `storage_unavailable` |
| Everything else | The live session continues; the record is marked `record_complete = false` with a failure count; the dashboard shows a red banner; reports carry a warning |
| Elevation | Forwarded immediately regardless — the relay must not hold a credential-bearing frame while waiting on a database; recorded best-effort |

**Restart**: at startup, before listening, every session still `waiting_*` or
`active` is ended as `server_restart` with a `session.interrupted` event.
Assumes one relay process per database (the architecture has one).

## 6. Chat

Saved to `chat_messages` **before** it is forwarded or acknowledged; the
sender's "sent" tick means "recorded". A retry with the same `clientId` from the
same side returns the stored row and is never forwarded twice. Existing limits
are unchanged: 4 000 characters, 30 messages / 10 s / session, `http(s)` URLs
only. The JSONL security log keeps who/when/length, never content. Notice that
chat is saved: console chat header (with the retention period), customer join
page, and the applet's chat window.

## 7. Metrics (definitions shown in the UI, computed in `routes/adminApi.ts`)

| Metric | Definition |
|---|---|
| Agents online | Distinct active users whose console sent a heartbeat (`POST /api/agent/presence`, every 30 s) within `PRESENCE_WINDOW_SECONDS` (90). One person with several sessions counts once. |
| Active sessions | Sessions with `status = 'active'`: the applet is connected and the customer accepted consent. |
| Waiting sessions | Code issued, or customer joined and consent pending. |
| Created today | `created_at` since midnight in `REPORT_TIMEZONE`. |
| Completed today | Became active, and ended since midnight. |
| Trend | Created vs completed per day, last 14 days. |
| By technician | Sessions, completed, total active time, last 30 days. |

Supervisors see all metrics scoped to their team.

## 8. Admin portal pages (`admin-portal/public/`)

Overview · Agents & access (pending/active/suspended, activation, limits,
teams, Entra-assignment guidance) · Live sessions (5 s refresh; End session for
Admin/Supervisor — no viewing or control from the portal) · Session history
(search by session ID / technician / device / user; filters: status, team,
device, dates; sort; pagination; CSV of the current filter) · Session detail
(metadata, device, consent, duration, end reason, record-integrity banner,
timeline, transcript and notes behind an audited "View" button, PDF export) ·
Reports (my exports, status, expiry, download) · Audit trail (filters) ·
Settings (retention, session and metric parameters, read-only).

Rendering is `textContent`-only; links are created only for `http(s)` URLs with
`rel="noopener noreferrer"`.

## 9. Reports

* **Session PDF** (`pdfkit`): metadata, technician, device, consent, duration,
  end reason, record-integrity warning, full timeline, and — only if the role
  allows and the requester ticks them — chat transcript and notes (all
  revisions).
* **Summary CSV**: one row per session under the history filters: session ID,
  created, technician, agent ID, team, status, end reason, consent, machine,
  Windows user, OS, active from, ended, duration (s), record complete. No chat
  bodies or notes. Formula-looking cells are neutralised with a leading `'`.
  Capped at 50 000 rows.
* **Lifecycle**: request (audited) → background generation → `ready` →
  download by the requester only, within `REPORT_TTL_MINUTES`, each download
  audited; refusals audited as `report.denied`; bytes erased after expiry.
* **Never included**: pairing codes, credentials or account names used for
  elevation, script text or output, tokens, cookies.
* **Fonts / languages**: reports embed Noto Sans (Latin, Greek, Cyrillic) and
  Noto Sans Tamil (`server/assets/fonts/`, SIL OFL). Text is split into runs per
  script, Tamil is shaped by fontkit's OpenType Indic shaper (vowel-sign
  reordering, conjuncts), and every run sits on one baseline. Characters neither
  font covers (emoji, CJK, some symbols such as →) print as `?`. Adding another
  script = add its Noto font and one branch in `scriptRuns()`. The CSV is UTF-8
  with a BOM so Excel opens Tamil correctly.

## 10. APIs

Agent application (`/api/agent`, console session + CSRF):
`GET /me`, `POST /presence`, `GET|POST /sessions/:id/notes` (own sessions only).

Admin application (`/api/admin`, admin-portal session + CSRF):

| Route | Permission |
|---|---|
| `GET /me`, `GET /settings` | signed in / dashboard.view |
| `GET /dashboard` | dashboard.view |
| `GET /users`, `GET /teams` | users.read (supervisor: own team) |
| `POST /users/:id/activate|suspend|reactivate`, `PATCH /users/:id` | users.manage |
| `POST /teams`, `PATCH /teams/:id` | teams.manage |
| `GET /sessions/live`, `GET /sessions`, `GET /sessions/:id` | sessions.read (scoped) |
| `GET /sessions/:id/transcript` | transcripts.read (scoped, audited) |
| `GET /sessions/:id/notes` | notes.read (scoped, audited) |
| `POST /sessions/:id/terminate` | sessions.terminate (scoped, audited) |
| `POST /reports`, `GET /reports`, `GET /reports/:id`, `GET /reports/:id/download` | reports.export (+ scope; download: requester only) |
| `GET /audit` | audit.read |

Auth (both applications): `GET /auth/config`, `GET /auth/login`,
`GET /auth/callback`, `POST /auth/logout`; `POST /auth/dev/login` in dev mode only.

Rate limits: sign-in 20/min/IP; admin mutations 60/min/user; exports
10/min/user; notes 60/min/user; plus the existing join/create/chat/elevation limits.

## 11. Known limitations and future work

* **Single relay process per database.** Live sessions are in memory; restart
  reconciliation ends everything open. A multi-instance relay needs an instance
  column and sticky routing.
* **Entra removal is observed at next sign-in**, not mid-session (up to
  `AUTH_MAX_HOURS`). Suspend in the portal for immediate effect. SCIM
  provisioning (auto-suspend on Entra removal) is the natural extension.
* **No Graph integration**: the portal cannot assign Entra roles; it says so.
* **Transcript search** is by session metadata, not message text.
* **Notes after the session**: the console saves notes while the session is
  live; post-session wrap-up notes would need a small console change.
* **PDF fonts**: English and Tamil (plus Greek/Cyrillic); other scripts and
  emoji print as `?` (see §9).
