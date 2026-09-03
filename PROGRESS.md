# Helpdesk Anywhere — Development Progress

> Machine-readable state of the project. A fresh Claude Code session should read
> this, `TASKS.md`, `MANUAL_TESTS.md`, `ARCHITECTURE.md` and `DECISIONS.md`, then
> `git log`, and continue from **Exact Next Task** — without asking what happened.
>
> `CLAUDE.md` and `PLAN.md` are the immutable specification and are never edited.
> Findings and deviations go to `DEV_NOTES.md` and `DECISIONS.md`.

**Last updated:** 2026-09-03

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
Phase 7  ⚪ NOT STARTED                 package, TLS, deploy, internet test
```

## Current Phase

Phases 2, 3, 4 and 6 are all complete as far as Ubuntu allows. Next up: Phase 7
(package, TLS, deploy), then Phase 5 (UAC) as the declared stretch goal.

## Current Milestone

None in flight. Phases 2, 3 and 4 are all IMPLEMENTED + BUILD VERIFIED with their
Windows acceptance pending.

## Last Completed Task

Phase 6 — remote script execution. Console pane, streaming protocol and both audit
guardrails verified on Linux (21 checks). Actually running PowerShell needs Windows.

## Currently Working On

Nothing in flight.

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

## Implemented / Manual Acceptance Pending

- **MT-01** — Phase 2, applet connect/consent/indicator end to end.
- **MT-02** — Phase 3, live desktop at >=8 FPS, cursor, multi-monitor, resize.
- **MT-03** — Phase 4, cursor accuracy at the corners, drag, typing, no stuck
  modifier after an abrupt disconnect.
- **MT-04** — Phase 6, real PowerShell, incremental streaming, the 120s timeout,
  the SYSTEM refusal, and the audit records.

All four are in `MANUAL_TESTS.md` and none can be marked PASSED by Claude.

## Pending

Phase 7 (package, TLS, deploy, internet test) and Phase 5 (UAC, stretch) per
`PLAN.md`.

## Known Bugs

None known. Nothing in `windows/` has executed on real hardware yet, so absence of
known bugs is not evidence of correctness there.

## Blockers

- **GitHub push — BLOCKED, needs the user.** No `origin` remote is configured, and
  this VM has no GitHub credentials (no `gh` CLI, no credential helper, no SSH
  private key). `git remote add` is additionally denied by the sandbox permission
  classifier. All work is committed locally on `main` and will push cleanly once a
  remote and credentials exist. See `DECISIONS.md` → D-003.

## Manual Tests Pending

- **MT-01** — Phase 2 applet end-to-end on Windows (`MANUAL_TESTS.md`).

## Automated Tests Passing

Run from the repo root; both harnesses live in the session scratchpad, not the repo
(see `DEV_NOTES.md` → "Test environment"):

- Phase 1 acceptance harness — 71 checks (headless Chrome, two-tab flow).
- `AppletConfig` URL/code parsing — 22 cases.
- Applet wire-frame replay against the live relay — 12 checks.
- Phase 3.4 renderer in headless Chrome against the live relay — 19 checks.
- `TileGrid` dirty-rect coalescing — 12 cases incl. a 200-grid random invariant.
- Phase 4.1 browser input capture and coordinate mapping — 20 checks.
- `KeyMap` event.code → VK — 12 checks.
- Phase 6 script pane, streaming and audit guardrails — 21 checks.
- `dotnet build windows/HelpdeskAnywhere.sln -c Release` — 0 warnings, 0 errors.
- `npm --prefix server run typecheck` — clean.

## Automated Tests Failing

None.

## Deployment Status

Not deployed. `docker-compose.yml` + `Caddyfile` exist from Phase 0 but have not been
brought up; DuckDNS hostname not yet registered. That is Phase 7 work.

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

## Latest Git Commit

The Phase 4 commit on `main`. Run `git log --oneline -5` for the current head.

## GitHub Push Status

**NOT PUSHED.** See Blockers.

## Exact Next Task

Phase 7 — package, TLS, deploy (`PLAN.md` 7.1–7.4): bring up `docker-compose.yml`,
register the DuckDNS hostname, and get Caddy issuing a real certificate. 7.7's
internet end-to-end test is itself a manual test and depends on MT-01–MT-04.

Phase 7.2 needs **user input**: a DuckDNS subdomain and token, which are account
credentials this session does not have.

## Recommended Continuation

Phase 7 deployment, then Phase 5 (UAC) as the stretch it is declared to be. Do not
gate any of it on MT-01…MT-04 (`DECISIONS.md` → D-002).
