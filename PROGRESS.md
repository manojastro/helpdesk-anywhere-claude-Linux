# Helpdesk Anywhere — Development Progress

> Machine-readable state of the project. A fresh Claude Code session should read
> this, `TASKS.md`, `MANUAL_TESTS.md`, `ARCHITECTURE.md` and `DECISIONS.md`, then
> `git log`, and continue from **Exact Next Task** — without asking what happened.
>
> `CLAUDE.md` and `PLAN.md` are the immutable specification and are never edited.
> Findings and deviations go to `DEV_NOTES.md` and `DECISIONS.md`.

**Last updated:** 2026-09-03 (regression suite)

## Overall Status

```
Phase 0  ✅ COMPLETE                    environment + scaffold
Phase 1  ✅ COMPLETE                    server: sessions, pairing, relay, portal
Phase 2  🟡 IMPLEMENTED · BUILD VERIFIED · LINUX INTEGRATION VERIFIED
                                        WINDOWS MANUAL ACCEPTANCE PENDING
Phase 3  🟡 IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED
                                        WINDOWS MANUAL ACCEPTANCE PENDING (MT-02)
Phase 4  🟡 IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED
                                        WINDOWS MANUAL ACCEPTANCE PENDING (MT-03)
Phase 5  ⚪ NOT STARTED                 UAC / secure desktop (stretch, deferred)
Phase 6  🟡 IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED
                                        WINDOWS MANUAL ACCEPTANCE PENDING (MT-04)
Phase 7  🟡 IMPLEMENTED · BUILD VERIFIED · LINUX INTEGRATION VERIFIED
                                        EXTERNAL ACCESS PENDING (MT-05, needs an
                                        ngrok token); DuckDNS path needs a token too
```

## Current Phase

Phases 2, 3, 4, 6 and 7 are all complete as far as Ubuntu allows. The whole stack
runs in Docker and the entire browser regression suite passes against the
containerised deployment with console authentication on.

Remaining: Phase 5 (UAC — declared stretch goal), and the Windows manual tests.

## Current Milestone

None in flight. Phases 2, 3 and 4 are all IMPLEMENTED + BUILD VERIFIED with their
Windows acceptance pending.

## Last Completed Task

Security review of the whole tree — four defects found and fixed, each with a
regression test that fails against the previous code: a console-auth bypass via
path traversal, an unrestricted WebSocket Origin, an unbounded `agent.create`,
and a wire-supplied exec id that could stage a script outside the session's temp
folder. Write-up in `DEV_NOTES.md` → "Security review".

Before that: regression suite promoted into the repo as `tests/`, run by
`./scripts/run-tests.sh`. Previously it existed only in session scratchpads under
`/tmp` — one reboot from gone, and unrunnable by a fresh session.

Before that: Phase 7 — deployment. Docker profiles for ngrok (temporary) and DuckDNS+Caddy
(permanent) over one identical app service, console authentication, deployment and
audit verification tooling, and `DEPLOYMENT.md`. Fixed a real defect found by that
tooling: the audit log silently failed to write in Docker.

## Currently Working On

Phase 5 (UAC / Secure Desktop) — the declared stretch goal and the only
remaining implementation work. The local stack
is up on 127.0.0.1:8080 via `docker-compose.local.yml`; the test suite uses 8099
so the two never collide.

## Completed

- Phase 0 — Ubuntu toolchain, cross-compile proof, project scaffold.
- Phase 1 — session store + 6-digit codes, WSS signaling/relay, agent console,
  join page, JSONL audit log, credential-elevation transport guard.
- Phase 2 — code-entry form, consent dialog, session indicator, `SessionClient`
  transport, teardown wiring, server-URL bake at publish time.
- Phase 3 — GDI capture with cursor compositing, JPEG encode, dirty-rect tiles,
  10 FPS streamer, canvas renderer, FPS/kbps counter.
- Phase 4 — browser mouse/keyboard capture, backing-store coordinate mapping,
  `SendInput` injection, key table, special-key buttons, release-on-disconnect.
- Phase 6 — `ScriptRunner` with streamed output, timeout and tree-kill; console
  script pane with run history; audit guardrails.
- Phase 7 — Docker deployment with ngrok and TLS profiles, console authentication,
  security headers, health/restart/log-rotation, deployment and audit verification
  scripts, `DEPLOYMENT.md`.
- Regression suite — `tests/` (17 blocks, ~220 checks), `scripts/run-tests.sh`,
  `tests/setup-browser.sh`, `tests/README.md`.
- Security review — four defects fixed with regressions; `DEV_NOTES.md` →
  "Security review".

## Implemented / Manual Acceptance Pending

- **MT-01** — Phase 2, applet connect/consent/indicator end to end.
- **MT-02** — Phase 3, live desktop at >=8 FPS, cursor, multi-monitor, resize.
- **MT-03** — Phase 4, cursor accuracy at the corners, drag, typing, no stuck
  modifier after an abrupt disconnect.
- **MT-04** — Phase 6, real PowerShell, incremental streaming, the 120s timeout,
  the SYSTEM refusal, and the audit records.
- **MT-05** — Phase 7, external access end to end over the tunnel. **Run this
  first**: MT-01…MT-04 all need a reachable HTTPS endpoint.

All five are in `MANUAL_TESTS.md` and none can be marked PASSED by Claude.

## Pending

- Phase 5 (UAC / Secure Desktop) — the declared stretch goal.
- Phase 7.2/7.4 — the permanent DuckDNS hostname and cloud firewall, whenever a
  DuckDNS token is available. The ngrok path covers external access until then.

## Known Bugs

None known. Four security defects were found and fixed on 2026-09-03; see
`DEV_NOTES.md` → "Security review". One accepted limitation remains: there is no
Content-Security-Policy, because the join page carries an inline script and a
policy that silently breaks the one page a stressed end user must follow would be
worse than none. Adding it needs a nonce. Nothing in `windows/` has executed on real hardware yet, so absence of
known bugs is not evidence of correctness there.

## Blockers

- **GitHub push — needs the user's credentials.** `origin` is now configured and
  reachable, but this VM has no way to authenticate. See GitHub Push Status below
  and `DECISIONS.md` → D-003.
- **External access — needs an ngrok authtoken** in `.env` (`NGROK_AUTHTOKEN`).
  Everything else about the deployment is done and verified locally.
- **Phase 7.2/7.4 (DuckDNS + cloud firewall)** — needs a DuckDNS token. Not on the
  critical path; the ngrok profile covers external access.

## Manual Tests Pending

- **MT-01** — Phase 2 applet end-to-end on Windows (`MANUAL_TESTS.md`).

## Automated Tests Passing

**One command: `./scripts/run-tests.sh`** — 17 blocks, ~220 checks, all green.
The suite lives in `tests/` (see `tests/README.md`); it no longer depends on any
session scratchpad.

- `ws/01`–`ws/06` — Phase 1 happy path/burn/teardown (17), join rate limiting
  (4), code expiry (4), decline + state machine (11), audit log and the
  constraint #6 credential sentinel (15), applet wire replay (12).
- `browser/10`–`browser/13` — Phase 1 two-tab console flow (20), Phase 3.4
  renderer and counters (19), Phase 4.1 input capture and coordinate mapping
  (20), Phase 6 script pane, streaming and audit guardrails (21).
- `ws/07` — the 14 security regressions from the 2026-09-03 review.
- `dotnet/*` — `AppletConfig` (22), `Protocol`, `TileGrid` (12), `KeyMap` (12),
  `ScriptStaging` (17), plus `dotnet build windows/HelpdeskAnywhere.sln
  -c Release` — 0 warnings.
- Green **both** with and without `CONSOLE_PASSWORD`, i.e. against the
  authenticated console as deployed (D-008).
- `scripts/verify-deployment.sh` — 12 checks against the running container.
- `scripts/verify-audit.sh` — 5 checks incl. the constraint #6 credential scan.
- `npm --prefix server run typecheck` — clean.

## Automated Tests Failing

None.

## Deployment Status

**Runs in Docker, verified locally; not yet exposed externally.**

- `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d app`
  is currently up on 127.0.0.1:8080 (loopback only).
- `./scripts/deploy-ngrok.sh` is ready and needs `NGROK_AUTHTOKEN` in `.env`.
- `./scripts/deploy.sh` (DuckDNS + Caddy) is ready and needs a DuckDNS hostname.
- `.env` exists locally with **placeholder** values — replace `CONSOLE_PASSWORD`
  and `NGROK_AUTHTOKEN` before exposing anything.

## Important Architecture Decisions

See `DECISIONS.md`. Summary: Linux server is matchmaker + relay only; all capture,
input and elevation happen inside the Windows applet; both endpoints dial out over
WSS/443; consent gates every byte.

## Important Files Changed

- Phase 2: `windows/Applet/{AppletConfig,AppletContext,SessionClient,Program}.cs`,
  `windows/Applet/Forms/*`, `Applet.csproj`, `scripts/build-windows.sh`.
- Phase 3: `windows/Applet/Capture/*`, `windows/Applet/Interop/{Gdi32,User32}.cs`,
  `server/public/portal.js`.
- Phase 4: `windows/Applet/Input/*`, `windows/Applet/Interop/Input.cs`,
  `server/public/{portal.js,portal.html,portal.css}`.
- Phase 6: `windows/Applet/Scripting/ScriptRunner.cs`, `shared/protocol.md` +
  both mirrors (`partial` flag), `server/src/signaling.ts`, console script pane.
- Phase 7: `docker-compose.yml` (profiles), `docker-compose.local.yml`, `Caddyfile`,
  `server/src/{auth,index,audit,config,signaling}.ts`, `scripts/{deploy-ngrok,
  verify-deployment,verify-audit,deploy}.sh`, `DEPLOYMENT.md`, `.env.example`,
  `.gitignore`.

## Latest Git Commit

The Phase 4 commit on `main`. Run `git log --oneline -5` for the current head.

## GitHub Push Status

**Remote configured, NOT PUSHED — needs the user's credentials.**

`origin` is set to the repository and is reachable (`git ls-remote` succeeds
anonymously; the repo is public and currently empty). The push fails with
`could not read Username for 'https://github.com'` because this VM has no GitHub
credentials — no `gh` CLI, no credential helper, no SSH key.

To publish all seven commits:

```bash
gh auth login          # or configure a PAT / SSH key
git push -u origin main
```

## Exact Next Task

Everything that can be done without Windows or an external account is done. The
next task depends on what becomes available:

1. **User provides an ngrok token** → run `./scripts/deploy-ngrok.sh` and work
   through MT-05, then MT-01…MT-04. This is the highest-value next step.
2. **Otherwise** → Phase 5 (UAC / Secure Desktop), the declared stretch goal.
   Legitimate, supported approaches only: a service running as LocalSystem that
   opens the Winlogon desktop and relays frames over the existing pipe protocol.
   No security-control bypasses, no AV evasion (`CLAUDE.md`, PLAN 5.1).

## Recommended Continuation

Phase 5 is the only remaining implementation work. It is ~30% of the plan's
estimate and its highest risk; `PLAN.md` itself says everything else still demos
without it. Do not start it expecting to finish it without a Windows machine — its
entire surface is untestable here.
