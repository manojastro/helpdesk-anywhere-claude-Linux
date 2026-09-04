# Helpdesk Anywhere — Development Progress

> Machine-readable state of the project. A fresh Claude Code session should read
> this, `TASKS.md`, `MANUAL_TESTS.md`, `ARCHITECTURE.md` and `DECISIONS.md`, then
> `git log`, and continue from **Exact Next Task** — without asking what happened.
>
> `CLAUDE.md` and `PLAN.md` are the immutable specification and are never edited.
> Findings and deviations go to `DEV_NOTES.md` and `DECISIONS.md`.

**Last updated:** 2026-09-04 (Phase 5 implemented and reviewed)

## Overall Status

```
Phase 0  ✅ COMPLETE                    environment + scaffold
Phase 1  ✅ COMPLETE                    server: sessions, pairing, relay, portal
Phase 2  🟡 IMPLEMENTED · BUILD VERIFIED · LINUX INTEGRATION VERIFIED
                                        WINDOWS MANUAL ACCEPTANCE PENDING (MT-01)
Phase 3  🟡 IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED
                                        WINDOWS MANUAL ACCEPTANCE PENDING (MT-02)
Phase 4  🟡 IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED
                                        WINDOWS MANUAL ACCEPTANCE PENDING (MT-03)
Phase 5  🟣 STRETCH · IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED
            where Linux can reach       WINDOWS MANUAL ACCEPTANCE PENDING (MT-06)
Phase 6  🟡 IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED
                                        WINDOWS MANUAL ACCEPTANCE PENDING (MT-04)
Phase 7  🟡 IMPLEMENTED · LOCAL DEPLOYMENT VERIFIED
                                        EXTERNAL NETWORK ACCEPTANCE PENDING (MT-05,
                                        needs an ngrok or DuckDNS token)
```

**Nothing under `windows/` has ever executed.** It cross-compiles on Ubuntu and
runs only on Windows. Every 🟡/🟣 above means exactly that and nothing more —
see `CLAUDE.md` → "Hard environment boundary".

## Current Phase

All seven phases are implemented as far as Ubuntu allows. What remains is
acceptance that requires either a Windows machine (MT-01…MT-04, MT-06), an
external token (MT-05), or GitHub credentials (the push).

## Last Completed Task

**A cross-phase review of phases 1–7**, on the principle that code which builds
is not thereby correct. Seven findings, none of them in Phase 5 — the phase that
had just been reviewed. The two worth knowing: both teardown paths stopped screen
capture *last* rather than first, so the user's screen kept streaming through a
service uninstall and a process-tree kill after they clicked End Session; and a
cross-thread race on the held-key set could throw inside a teardown chain whose
steps were unguarded, skipping the step that removes a LocalSystem service.

Also: the Caddy/TLS deployment path is verified locally for the first time
(`scripts/verify-tls-local.sh`, 9 checks) using Caddy's internal CA — it never
needed the DuckDNS token to test the proxy configuration itself.

Full list in `CHANGELOG.md` → Cross-phase review.

## Previously

**Phase 5 — UAC / Secure Desktop**, implemented, reviewed and committed. Both
elevation modes, the LocalSystem service, the per-desktop helper, the ACL'd named
pipe, `kind:"sas"` for Ctrl+Alt+Del, and `asSystem` scripts routed to the service.

The review that followed found and fixed eleven defects, two of them serious: the
service watchdog could never fire (a malformed pipe path meant the constraint-#4
backstop was dead code), and the `%ProgramData%` staging directory inherited
permissions that let an ordinary user pre-create it and replace a binary about to
run as SYSTEM. Full list in `CHANGELOG.md` → Phase 5; the debugging notes a human
will want on the day are in `DEV_NOTES.md` → Phase 5.

## Currently Working On

Nothing in flight. Everything that does not require Windows, an external token
or GitHub credentials is done.

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
- Phase 5 — elevation modes A and B, `SecureDesktopService`, `DesktopHelper`,
  `SecureDesktopBridge`, `ElevationErrors`, SAS routing, `asSystem` execution,
  two independent uninstall routes.
- Phase 6 — `ScriptRunner` with streamed output, timeout and tree-kill; console
  script pane with run history; audit guardrails.
- Phase 7 — Docker deployment with ngrok and TLS profiles, console authentication,
  security headers, health/restart/log-rotation, deployment and audit verification
  scripts, `DEPLOYMENT.md`.
- Regression suite — `tests/` (20 blocks), `scripts/run-tests.sh`,
  `tests/setup-browser.sh`, `tests/README.md`.
- Security reviews — 2026-09-03 (server/console/applet, four defects) and
  2026-09-04 (Phase 5, eleven defects). `DEV_NOTES.md` carries both.

## Implemented / Manual Acceptance Pending

- **MT-01** — Phase 2, applet connect/consent/indicator end to end.
- **MT-02** — Phase 3, live desktop at >=8 FPS, cursor, multi-monitor, resize.
- **MT-03** — Phase 4, cursor accuracy at the corners, drag, typing, no stuck
  modifier after an abrupt disconnect.
- **MT-04** — Phase 6, real PowerShell, incremental streaming, the 120s timeout,
  the SYSTEM refusal, and the audit records.
- **MT-05** — Phase 7, external access end to end over the tunnel. **Run this
  first**: every other MT needs a reachable HTTPS endpoint.
- **MT-06** — Phase 5, UAC / Secure Desktop. **Run twice**: once from a local
  administrator account (mode A) and once from a standard user account (mode B).

All six are in `MANUAL_TESTS.md` and none can be marked PASSED by Claude.

## Pending

- Phase 7.2/7.4 — the permanent DuckDNS hostname and cloud firewall, whenever a
  DuckDNS token is available. The ngrok path covers external access until then.
- The GitHub push (below).

## Known Bugs

None known. Accepted limitations, all deliberate and recorded:

- **No Content-Security-Policy.** The join page carries an inline script, and a
  policy that silently breaks the one page a stressed end user must follow would
  be worse than none. Adding it needs a nonce; noted in `server/src/index.ts`.
- **The relay sees plaintext.** Credential-mode elevation is TLS-only and never
  logged or buffered, but the relay could read it in transit. Past a POC the fix
  is end-to-end encrypting the payload to a key the applet generates at session
  start (`shared/protocol.md`, `DEV_NOTES.md`).
- **The password exists briefly as a .NET `string`.** `System.Text.Json`
  materialises it before the applet can copy it into a zeroable buffer, and a
  .NET string cannot be overwritten. Every subsequent hop is zeroed.
- Nothing in `windows/` has executed on real hardware, so "no known bugs" there
  means "nothing the compiler, the source invariants or a careful read found".

## Blockers

- **GitHub push — needs the user's credentials.** `origin` is configured and
  reachable, but this VM has no way to authenticate (no `gh`, no helper, no SSH
  key). Development does not wait on it; commits accumulate locally.
- **External access — needs an ngrok authtoken** in `.env` (`NGROK_AUTHTOKEN`),
  or a DuckDNS token for the permanent path. Everything else about the deployment
  is done and verified locally.
- **Windows manual acceptance — needs the test machine** described in
  `CLAUDE.md`, with two accounts.

## Automated Tests Passing

**One command: `./scripts/run-tests.sh`** — 20 blocks, 250+ checks, all green.

- `ws/01`–`ws/06` — Phase 1 happy path/burn/teardown (17), join rate limiting
  (4), code expiry (4), decline + state machine (11), audit log and the
  constraint #6 credential sentinel (15), applet wire replay (12).
- `ws/07` — the 14 security regressions from the 2026-09-03 review.
- `source/15` — 28 Windows source invariants: no auto-start service, a pipe path
  that resolves, a password that reaches no log, a DACL that is not inherited.
  These exist because the Windows half cannot be executed here at all.
- `dotnet/*` — `AppletConfig` (22), `Protocol` (17), `TileGrid` (12), `KeyMap` (12),
  `ScriptStaging` (17), `ElevationErrors` (9), plus
  `dotnet build windows/HelpdeskAnywhere.sln -c Release` — 0 warnings.
- `browser/10`–`browser/14` — Phase 1 two-tab console flow (20), Phase 3.4
  renderer and counters (19), Phase 4.1 input capture and coordinate mapping
  (20), Phase 6 script pane and audit guardrails (21), Phase 5 elevation panel,
  banner and SAS (24).
- Green **both** with and without `CONSOLE_PASSWORD`, i.e. against the
  authenticated console as deployed (D-008).
- `scripts/verify-deployment.sh` — 12 checks against the running container.
- `scripts/verify-audit.sh` — 5 checks incl. the constraint #6 credential scan.
- `scripts/verify-tls-local.sh` — 9 checks against the **real Caddy service and
  the real Caddyfile**, using Caddy's internal CA so no DNS or Let's Encrypt is
  needed. This is the permanent deployment path (PLAN 7.3), previously untested
  because testing it looked like it needed a DuckDNS token. It does not.
- `npm --prefix server run typecheck` — clean.

## Automated Tests Failing

None.

## Deployment Status

**Runs in Docker, verified locally; not yet exposed externally.**

- `./scripts/dev-local.sh up` brings the stack up on 127.0.0.1:8080 (loopback
  only) and `./scripts/dev-local.sh verify` runs the deployment checks against it.
- `./scripts/deploy-ngrok.sh` is ready and needs `NGROK_AUTHTOKEN` in `.env`.
- `./scripts/deploy.sh` (DuckDNS + Caddy) is ready and needs a DuckDNS hostname.
  Its proxy configuration is verified locally by `./scripts/verify-tls-local.sh`;
  what the hostname is still needed for is ACME, DNS and the firewall.
- `.env` exists locally with **placeholder** values — replace `CONSOLE_PASSWORD`
  and `NGROK_AUTHTOKEN` before exposing anything.

## Important Architecture Decisions

See `DECISIONS.md`. Summary: the Linux server is matchmaker + relay only; all
capture, input, elevation and execution happen inside the Windows applet; both
endpoints dial out over WSS/443; consent gates every byte; the applet, the
elevated service and the desktop helper are one binary with three entry points
(D-009).

## Important Files Changed

- Phase 2: `windows/Applet/{AppletConfig,AppletContext,SessionClient,Program}.cs`,
  `windows/Applet/Forms/*`, `Applet.csproj`, `scripts/build-windows.sh`.
- Phase 3: `windows/Applet/Capture/*`, `windows/Applet/Interop/{Gdi32,User32}.cs`,
  `server/public/portal.js`.
- Phase 4: `windows/Applet/Input/*`, `windows/Applet/Interop/Input.cs`,
  `server/public/{portal.js,portal.html,portal.css}`.
- Phase 5: `windows/Applet/Elevation/*`,
  `windows/Applet/Interop/{AdvApi32,Kernel32,Desktops}.cs`,
  `windows/SecureDesktopService/*`, `windows/DesktopHelper/*`,
  `windows/Shared/PipeChannel.cs`, `windows/Applet/Capture/IFrameSink.cs`,
  all three protocol mirrors, the console's elevation panel.
- Phase 6: `windows/Applet/Scripting/ScriptRunner.cs`, `shared/protocol.md` +
  both mirrors (`partial` flag), `server/src/signaling.ts`, console script pane.
- Phase 7: `docker-compose.yml` (profiles), `docker-compose.local.yml`, `Caddyfile`,
  `server/src/{auth,index,audit,config,signaling}.ts`, `scripts/{deploy-ngrok,
  dev-local,verify-deployment,verify-audit,deploy}.sh`, `DEPLOYMENT.md`,
  `.env.example`, `.gitignore`.

## Latest Git Commit

`2c33942 docs: pin the commit count and head in PROGRESS` — 24 commits on `main`, working
tree clean. Run `git log --oneline -14` for this session's work: Phase 5, its
tests, the cross-phase review's fixes, and the documentation that records them.

## GitHub Push Status

**PENDING — authentication not configured.** Not a blocker on development.
**24 commits are waiting**, and they push together in one go.

`origin` is set and reachable (`git ls-remote` succeeds anonymously), but this VM
has no GitHub credentials — no `gh` CLI, no credential helper, no SSH key. The
push fails with `could not read Username for 'https://github.com'`.

Do not put a token in the remote URL and do not store credentials in the repo.
When the user is ready:

```bash
gh auth login          # or configure a PAT / SSH key
git push -u origin main
```

All local commits push together at that point.

## Exact Next Task

Everything that does not require Windows, an external token or GitHub
credentials is done. In priority order:

1. **User provides an ngrok token** → `./scripts/deploy-ngrok.sh`, then MT-05.
   That unblocks every other manual test, so it is the highest-value step.
2. **Windows test machine available** → MT-01, MT-02, MT-03, MT-04, then MT-06
   (twice: administrator account, then standard user).
3. **GitHub credentials available** → `gh auth login && git push -u origin main`.

Record results in `MANUAL_TESTS.md`. Only the user may mark an MT as PASSED.
