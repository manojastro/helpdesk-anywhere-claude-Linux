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
Phase 3  ⚪ NOT STARTED                 screen capture + streaming
Phase 4  ⚪ NOT STARTED                 remote input injection
Phase 5  ⚪ NOT STARTED                 UAC / secure desktop (stretch)
Phase 6  ⚪ NOT STARTED                 remote script execution
Phase 7  ⚪ NOT STARTED                 package, TLS, deploy, internet test
```

## Current Phase

Phase 3 — screen capture + streaming.

## Current Milestone

Phase 3.1 — Windows screen capture abstraction.

## Last Completed Task

Phase 2 applet implemented, built clean (0 warnings), and verified as far as Ubuntu
allows: `AppletConfig` parsing (22 cases) and a verbatim replay of the applet's own
wire frames against the live relay (12 checks).

## Currently Working On

Phase 3.1 capture abstraction.

## Completed

- Phase 0 — Ubuntu toolchain, cross-compile proof, project scaffold.
- Phase 1 — session store + 6-digit codes, WSS signaling/relay, agent console,
  join page, JSONL audit log, credential-elevation transport guard.
- Phase 2 — code-entry form, consent dialog, session indicator, `SessionClient`
  transport, teardown wiring, server-URL bake at publish time.

## Implemented / Manual Acceptance Pending

- Phase 2, end to end on Windows. See `MANUAL_TESTS.md` → **MT-01**.

## Pending

Phases 3, 4, 5, 6, 7 per `PLAN.md`.

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

Phase 2: `windows/Applet/{AppletConfig,AppletContext,SessionClient,Program}.cs`,
`windows/Applet/Forms/{CodeEntryForm,ConsentForm,IndicatorForm}.cs`,
`windows/Applet/Applet.csproj`, `scripts/build-windows.sh`, `DEV_NOTES.md`.

## Latest Git Commit

`744cb7f` Phase 1 — superseded by the Phase 2 commit landing with this file.

## GitHub Push Status

**NOT PUSHED.** See Blockers.

## Exact Next Task

Phase 3.1 — add `windows/Applet/Capture/` with an `IScreenCapture` abstraction and a
GDI `BitBlt` implementation behind it (`PLAN.md` 3.1), P/Invoke isolated in
`windows/Applet/Interop/`.

## Recommended Continuation

Work `TASKS.md` Phase 3 top to bottom. Build after each step, commit each stable
checkpoint. Do not gate Phase 3 on MT-01 — the user has explicitly overridden that
gate (`DECISIONS.md` → D-002).
