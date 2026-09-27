# Admin portal, Entra ID and durable records — implementation plan (Stage A)

Checkpoint before this work: tag `pre-admin-portal-2026-09-27` (= `2ac28ed`), branch
`feature/admin-portal`. Golden Windows tag `hda-windows-privileged-control-working-2026-09-06`
is untouched.

## Facts confirmed against the code (2026-09-27)

| Claim | Where | Confirmed |
|---|---|---|
| Live sessions are an in-memory `Map` keyed by the 6-digit code | `server/src/sessions.ts` `SessionStore` | yes |
| Audit is append-only JSONL, and every record carries the pairing `code` | `server/src/audit.ts` `audit(event, code, …)` | yes — conflicts with "no pairing codes in logs"; changed to the session UUID |
| Console access is one shared HTTP Basic password | `server/src/auth.ts`, `CONSOLE_PASSWORD` | yes |
| `AGENT_NAME` is static and is what the consent dialog shows | `config.agentName` → `host.connectRequest` in `signaling.ts` | yes; applet takes it verbatim from the wire (`AppletContext.cs:158`), so no Windows change is needed to replace it |
| Chat is relayed and de-duplicated in a 20-entry window, never stored | `signaling.ts` `dispatchChat`, `sessions.ts` `rememberChat` | yes |
| Notes never leave the browser; only their length is sent | `agent.notes.save { length }` | yes |

## Decisions (sensible defaults, documented)

* **One process, one relay.** Live WebSocket state stays in memory; PostgreSQL is the
  system of record for everything historical. Restart reconciliation assumes a single
  relay instance (documented; a multi-instance relay would need an instance id column).
* **Separate admin application** (owner's correction, D-015): its own frontend in
  `admin-portal/public/`, its own listener (`ADMIN_PORT`, `admin.<domain>`), cookie,
  sign-in and `/api/admin/*`; plain HTML/JS like the console (no build step), hash
  router, `textContent`-only rendering, same CSP.
* **Libraries:** `openid-client` v6 (OIDC code + PKCE, ID-token signature validation via
  `enableNonRepudiationChecks`), `pg`, `pdfkit`. Server-side sessions are a small
  in-repo table (`auth_sessions`, SHA-256 of the cookie value stored, never the value).
* **Shared Basic password removed** (supersedes D-008). The console and admin surfaces
  now require an Entra identity; `/j/*`, `/download/*`, `/healthz` stay public.
* **WebSocket upgrade:** a browser upgrade (has `Origin`) must carry a valid technician
  session or is refused 401; an upgrade with no `Origin` (the applet) is anonymous and
  may only ever send `host.join`. Identity is bound to the connection at upgrade.
* **Dev/test auth:** `AUTH_MODE=dev` adds `/auth/dev/login`. Fatal at startup when
  `NODE_ENV=production` (the Docker image sets it) or the host looks public.
* **Script text:** the JSONL security audit keeps the full script (PLAN 1.6 requires it);
  the database timeline and reports store only shell, size and SHA-256.
* **Sensitive writes fail closed:** session creation, chat, and script execution wait for
  the database write and refuse with an error if it fails. Elevation is *not* awaited
  (the credential frame must not be held by the relay); a failed event write marks the
  session record `record_complete = false`, shown in the UI.

## Stage map

| Stage | Files |
|---|---|
| B. PostgreSQL | `server/migrations/*.sql`, `server/src/db/{pool,migrate}.ts`, `docker-compose.yml` (`db` service), `.env.example` |
| C. Identity | `server/src/auth/{oidc,sessions,middleware,devAuth,identity,permissions}.ts`, `server/src/routes/auth.ts`, `public/login.*` |
| D. WS identity | `server/src/signaling.ts` (upgrade auth, per-message permission checks, verified agent name), `shared/protocol.md` + mirrors |
| E. Persistence | `server/src/records.ts` (sessions, events, chat, notes; per-session ordered write queue), reconciliation at startup |
| F. Admin UI + exports | `server/src/routes/{adminApi,agentApi}.ts`, `server/src/reports.ts`, `admin-portal/public/*`, console `identity.js` + header/notes/heartbeat in `portal.*` |
| G. Ops docs | `docs/ADMIN_PORTAL.md`, `docs/ENTRA_SETUP.md`, `DEPLOYMENT.md` addendum, `DECISIONS.md` D-014…, `DEV_NOTES.md` |
| H. Tests | `tests/lib/{server.sh,auth.mjs}` (Postgres + dev sign-in), existing blocks adapted, new `tests/api/*` blocks |

## Windows impact

None of the privileged-control components is touched. The consent dialog already shows
whatever `agentName` the relay sends. The only applet change considered is a one-line
"chat is saved" notice in `ChatForm.cs` (not a privileged component) — flagged for MT
verification.
