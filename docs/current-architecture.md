# Current architecture — baseline for Technician Platform 2.0

**Snapshot:** 2026-10-06, branch `feature/technician-platform-v2`, cut from
`audit/security-reliability-2026-10-05` @ `eb062a5`. Checkpoint tag:
`pre-technician-platform-v2-2026-10-06`.

This is the "before" picture the 2.0 work builds on. `ARCHITECTURE.md` describes the
original seven phases (last updated 2026-09-03) and is still accurate for the
Windows half; `docs/ADMIN_PORTAL.md` and `docs/MULTI_SESSION.md` describe the two
releases since. This file ties them together and records what exists today.

## Branch lineage — what is deployed vs. what is current

```
main (2ac28ed) ─────────────────────────── what the live container runs
  └─ feature/admin-portal (22ce263)        Entra, admin portal, PostgreSQL
       └─ feature/multi-session-support (2e69ad8)   4 sessions, technician reconnect
            └─ audit/security-reliability-2026-10-05 (eb062a5)   10 audit fixes
                 └─ feature/technician-platform-v2   ← this work
```

None of the three upper branches is merged to `main`. The 2.0 work stacks on them.

## Processes and listeners

```
┌──────────────────────────────┐            ┌─────────────────────────────────────────────┐
│ Technician console (browser) │── WSS /ws ─│ Node 22 process (server/)                    │
│ server/public/portal.*       │── HTTPS ───│  agent app  :8080  app.<domain>              │
└──────────────────────────────┘            │    /  /j/:code  /download  /ws  /api/agent/* │
┌──────────────────────────────┐            │    /auth/*                                    │
│ Admin portal (browser)       │── HTTPS ───│  admin app  :8081  admin.<domain>  (no /ws)  │
│ admin-portal/public/*        │            │    /  /api/admin/*  /auth/*                   │
└──────────────────────────────┘            │  in-memory relay: sessions.ts + signaling.ts │
┌──────────────────────────────┐            │  PostgreSQL (records)  +  JSONL audit file   │
│ Windows applet (.exe)        │── WSS /ws ─│                                              │
│ windows/*                    │            └─────────────────────────────────────────────┘
└──────────────────────────────┘
```

Both endpoints dial out. The server never decodes video and never touches a desktop.

## Server modules (`server/src`)

| Module | Role |
|---|---|
| `index.ts` | builds both Express apps, mounts routes, HTTP + WS servers, startup |
| `config.ts`, `startupChecks.ts` | env-only configuration; refuses unsafe combinations |
| `protocol.ts` | TypeScript mirror of `shared/protocol.md` |
| `sessions.ts` | live session store: 6-digit codes (`crypto.randomInt`), TTL, join limiter, resume tokens, catch-up buffer, `countForUser()` |
| `signaling.ts` | WS upgrade (cookie identity, Origin), role handshake, consent gate, relay, hold, chat, notes, exec, elevation, limit, resume/grace, preview priority |
| `records.ts` | durable session record + ordered timeline (`session_events`), chat, notes |
| `sessionQueries.ts` | history / detail queries for the admin portal |
| `reports.ts` | PDF (English + Tamil fonts) and CSV exports |
| `audit.ts`, `db/auditLog.ts` | JSONL security audit (key-based redaction) + DB admin audit |
| `retention.ts` | transcript purge, old-session deletion, report expiry |
| `auth/*` | OIDC (openid-client, PKCE), identity resolution, cookie sessions, CSRF/Origin, permissions |
| `routes/agentApi.ts` | `/api/agent/me`, `/presence`, `/sessions/live`, `/sessions/:id/notes` |
| `routes/adminApi.ts` | dashboard, users, teams, live sessions/technicians, history, transcript, notes, terminate, reports, audit |

## Session lifecycle (as implemented)

```
relay (memory):   waiting_for_host → waiting_for_consent → active → ended
                                                            │ ▲
                         technician socket drops ───────────┘ │ agent.resume (owner + token)
                         held: boolean on active    grace 60 s, then ended
DB sessions.status:  waiting_for_customer | waiting_for_consent | active | ended
                     + end_reason, consent_decision, reconnect_count, timestamps
```

There is no explicit transition table; transitions are implied by the handlers in
`signaling.ts`. "Held" and "reconnecting" exist only in memory. This is the first
gap Phase 1 closes.

## Wire protocol (`shared/protocol.md`)

One socket per session per side; no session id in any message body (isolation by
socket binding). JSON control frames with a `t` discriminator; binary video
`[0x01][jpeg]` / `[0x02][x][y][w][h][jpeg]` host → agent only.

Technician → relay: `agent.create`, `agent.resume`, `agent.view`, `agent.input`,
`agent.exec`, `agent.requestElevation`, `agent.hold`, `agent.chat`,
`agent.notes.save`, `agent.end`. Applet → relay: `host.join`, `host.consent`,
`host.execResult`, `host.elevated`, `host.desktopChanged`, `host.chat`. Relay →
peers: `session.created`, `session.resumed`, `host.connectRequest`,
`consent.result`, `peer.joined`, `peer.left`, `chat.message`, `chat.history`, `error`.
No protocol version field.

## Windows applet (`windows/`)

One self-contained `win-x64` .exe, four roles: applet (user), `--install-service`
(UAC-elevated), `--run-service` (LocalSystem, session 0), `--desktop-watch` (SYSTEM,
user session), `--desktop-helper` (SYSTEM, Winlogon desktop). Capture: GDI full
virtual desktop, 10 fps, JPEG q60, dirty-rect tiles — constants in
`ScreenStreamer.cs`. A dropped relay connection ends the applet (`SessionClient` →
`OnClosed` → `Program.Teardown`). See `docs/golden-features.md` for the protected parts.

## Identity and RBAC

Entra ID (OIDC code + PKCE, single tenant). App roles `Admin`, `Supervisor`, `Agent`,
`Auditor` from the ID token, narrowed by the `users` row (pending / active /
suspended, per-user limits, team). Permissions in `auth/permissions.ts`.
`AUTH_MODE=dev` is a loopback-only bypass for tests.

## Data (PostgreSQL, `server/migrations/`)

`organizations`, `teams`, `users`, `auth_sessions`, `sessions`, `session_events`,
`chat_messages`, `session_notes`, `report_exports`, `audit_log`. Migrations run at
startup under an advisory lock, forward-only. The pairing code is never stored.

## Tests

`./scripts/run-tests.sh` — baseline on 2026-10-06: **46 blocks passed, 0 failed**
(1,273 PASS lines). Manual Windows status: `MANUAL_TESTS.md` (MT-01/02/03 and MT-06
mode A passed; MT-04, 05, 06B, 07–12 pending).
