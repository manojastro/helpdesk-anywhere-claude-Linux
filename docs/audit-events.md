# Audit events

Two trails, on purpose (`docs/ADMIN_PORTAL.md`):

* **Security log** — append-only JSONL files (`AUDIT_DIR`, one per day), written by the relay. Session
  lifecycle, consent, elevation, scripts (full text), files, clipboard (length only), transfers.
* **Admin audit trail** — the `audit_log` table, shown in the admin portal: sign-ins, access changes,
  transcript/notes views, report exports, script-library changes.

Separately, every session has a **timeline** (`session_events`) — the readable activity history
shown to technicians and in reports. It is not the security record.

## The brief's event names → what is recorded

| Brief | Where | Event | Fields kept |
|---|---|---|---|
| LOGIN_SUCCESS | admin trail | `auth.login` | user, portal, method, IP |
| LOGIN_FAILURE | admin trail | `auth.login_refused` | reason, claimed identity, IP |
| SESSION_CREATED | security log + timeline | `session.created` | session id, technician, IP (never the PIN) |
| SESSION_CONNECTED | security log + timeline | `session.consent` (accepted) → `session.active` | machine, Windows user |
| SESSION_ENDED | security log + timeline | `session.ended` | end reason, duration |
| REMOTE_CONTROL_STARTED | timeline | `session.phase` → `CONTROLLING` | time |
| UAC_ELEVATION | security log + timeline | `elevation.requested` / `elevation.result` | mode, username (credential mode), outcome — **never the password** |
| CTRL_ALT_DEL_SENT | security log + timeline | `input.sas` / `sas.sent` | time |
| FILE_UPLOAD / FILE_DOWNLOAD | security log + timeline + `file_transfers` | `file.transfer` | direction, name, path, size, bytes, status, SHA-256 — **never contents** |
| SCRIPT_EXECUTION | security log + timeline | `exec.requested` (full text, before it runs), `exec.result`, `exec.cancel` | shell, SYSTEM?, saved-script name/version, exit code |
| DEVICE_RESTART | — | not implemented (D-018) | — |
| SESSION_TRANSFER | security log + timeline + `session_transfers` | `session.transfer` (each stage), `session.consent` with `transfer: true` | from, to, outcome |
| ROLE_CHANGED | admin trail | `access.updated` / `access.activated` | before/after (roles themselves live in Entra) |
| TECHNICIAN_DISABLED | admin trail | `access.suspended` | reason, by whom |
| — (2.0 additions) | security log | `fs.list`, `fs.changed`, `clipboard.sent`, `clipboard.read`, `screenshot.taken`, `session.host_reconnecting`, `session.host_resumed`, `session.invalid_transition` | paths, lengths, counts |
| — (2.0 additions) | admin trail | `script.created` / `script.updated` / `script.archived` | name, version, SHA-256 |

**Never stored anywhere:** passwords, access/ID/refresh tokens, cookies, authorization headers,
resume tokens, pairing codes, clipboard text, file contents. `redact()` in `server/src/audit.ts`
removes credential-named keys from every security-log record as a second line; `ws/05`,
`ws/14` and `api/33` check with sentinel values.

Each security-log line carries `ts`, `event`, `session` (UUID) and the fields above; each admin
line `at`, actor id + label, `action`, target type/id, `detail`, IP. Both are append-only from the
application's point of view; protect the files and table at the operating-system/DB level for
tamper resistance.
