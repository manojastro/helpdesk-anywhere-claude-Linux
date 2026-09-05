# Helpdesk Anywhere — Development Progress

> Machine-readable state of the project. A fresh Claude Code session should read
> this, `TASKS.md`, `MANUAL_TESTS.md`, `ARCHITECTURE.md` and `DECISIONS.md`, then
> `git log`, and continue from **Exact Next Task** — without asking what happened.
>
> `CLAUDE.md` and `PLAN.md` are the immutable specification and are never edited.
> Findings and deviations go to `DEV_NOTES.md` and `DECISIONS.md`.

**Last updated:** 2026-09-05 (redeployment verified; 16/16, regression 277/277)

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
Phase 7  🟡 IMPLEMENTED · EXTERNAL DEPLOYMENT VERIFIED (ngrok, 16/16)
                                        WINDOWS MANUAL ACCEPTANCE PENDING (MT-05)
```

**Nothing under `windows/` has ever executed.** It cross-compiles on Ubuntu and
runs only on Windows. Every 🟡/🟣 above means exactly that and nothing more —
see `CLAUDE.md` → "Hard environment boundary".

## Current Phase

All seven phases are implemented as far as Ubuntu allows, and the deployment is
now live on a public HTTPS URL. What remains needs the Windows machine and
nothing else: MT-05 first, then MT-01…MT-04 and MT-06 over that connection.

**Live deployment** (ngrok, no reserved domain — this URL dies with the tunnel):

```
console   https://paternity-cannot-removal.ngrok-free.dev/        (Basic auth, user "agent")
join      https://paternity-cannot-removal.ngrok-free.dev/j/<6-digit code>
download  https://paternity-cannot-removal.ngrok-free.dev/download/HelpdeskAnywhere.exe
applet    baked with wss://paternity-cannot-removal.ngrok-free.dev/ws
```

## Last Completed Task

**A full build → test → verify pass over the live deployment** (2026-09-05).
No application code changed. `npm run build` clean; regression 21 blocks / 277
assertions, 0 failed; `verify-deployment.sh` 16/16 against the live tunnel;
`verify-tls-local.sh` 9/9; `verify-audit.sh` 5/5; `npm audit --omit=dev` 0
vulnerabilities. The applet was rebuilt against the same URL, and the bytes served
over the public HTTPS URL sha256-match the local file.

Two operational findings, both recorded in `DEV_NOTES.md` → "Redeployment
verification": `verify-tls-local.sh` shares the `helpdeskanywhere` compose project
name and its cleanup removes a live `app` container (the tunnel 502s until it is
restarted; the URL itself survives), and two limitations in `DEPLOYMENT.md` had
outlived the facts behind them — the CSP shipped in `5a15af3`, and `npm audit`
runs fine now.

**Still nothing has run on Windows.** MT-01…MT-06 are unchanged and pending.

## Previously Completed Task

**The first external deployment**, and the two verification failures it produced.

`verify-deployment.sh` reported 14 passed, 2 failed: the `/ws` upgrade came back
`HTTP/2 401` instead of 101, and a foreign browser Origin came back `HTTP/2 401`
instead of 403. Both were the harness. `Connection` and `Upgrade` are hop-by-hop
headers HTTP/2 forbids, so curl — having negotiated h2 by ALPN with ngrok's edge —
dropped them and sent a bare `GET /ws`, which is not an upgrade, never reaches
`ws`, and falls through to the console's Basic auth. Forcing `--http1.1`, which is
what browsers and the applet's `ClientWebSocket` actually speak, gives 101 and 403.
No application check was weakened; each was confirmed by hand against the live
tunnel first.

One real defect underneath: the server answered that bare GET with 401, a true
refusal of the wrong kind, which is what sent the diagnosis toward authentication
code that was working. `GET /ws` without an upgrade now answers **426**.

And one real configuration defect nothing was checking: `/healthz` still reported
`publicHost: localhost:8080` on a public tunnel, because the app has to start
before the tunnel that will reach it exists. That value is what `build-windows.sh`
bakes into the `.exe` when `SERVER_URL` is not passed, so the quiet failure was an
applet dialling `wss://localhost:8080/ws` on the end user's machine.
`deploy-ngrok.sh` now writes the discovered hostname back and restarts the app
before it verifies.

Full reasoning in `DEV_NOTES.md` → "First external deployment"; the summary is in
`CHANGELOG.md`.

## Previously

**The last two Linux-side tasks in the backlog**, both open only for want of
network access, which the GitHub setup incidentally provided.

`npm audit` ran for the first time and reported three moderate advisories, all
in `qs` and all reachable: express parses a query string on every request, and
Phase 7 exposes the join endpoint unauthenticated. Express 4 pins `~6.15.1` and
so cannot reach the fix on its own; an `overrides` entry takes it to 6.16.0.
Audit is now clean with and without dev dependencies.

**A Content-Security-Policy**, which had been deferred as needing a nonce. It
did not. The join page's inline script was pure client-side — it reads the code
out of `location.pathname` — so moving it to `/join.js` makes `script-src
'self'` sufficient, with no per-request templating of a static file. `browser/16`
proves the policy is enforced *and* that neither page breaks under it: a CSP
violation blocks a resource silently rather than throwing, so the block watches
`securitypolicyviolation` and then asserts the scripts' effects. Confirmed to
fail when the invariant is broken, per the convention for this suite. The
deployment script gained two checks so a proxy stripping the header is caught.

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

Nothing in flight. Everything that does not require a Windows machine is done,
the deployment is live and verified 16/16, and `main` is pushed to GitHub and
verified in sync.

**Exact Next Task:** MT-05, on the Windows machine, against the live URL above.
It is a human step and cannot be marked PASSED here (`CLAUDE.md` → "Hard
environment boundary").

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
- Regression suite — `tests/` (21 blocks), `scripts/run-tests.sh`,
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
  first**: every other MT needs a reachable HTTPS endpoint. The endpoint now
  exists and passes 16/16 at the HTTP/WS level; what is pending is the Windows
  half — download, SmartScreen, code entry, consent.
- **MT-06** — Phase 5, UAC / Secure Desktop. **Run twice**: once from a local
  administrator account (mode A) and once from a standard user account (mode B).

All six are in `MANUAL_TESTS.md` and none can be marked PASSED by Claude.

## Pending

- Phase 7.2/7.4 — the permanent DuckDNS hostname and cloud firewall, whenever a
  DuckDNS token is available. The ngrok path covers external access until then.
- A reserved ngrok domain (`NGROK_URL` in `.env`). Without one the URL changes on
  every tunnel restart, which means re-baking the `.exe` each time. Free to
  reserve on the ngrok dashboard.

## Known Bugs

None known. Accepted limitations, all deliberate and recorded:

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

- **External access — needs an ngrok authtoken** in `.env` (`NGROK_AUTHTOKEN`),
  or a DuckDNS token for the permanent path. Everything else about the deployment
  is done and verified locally.
- **Windows manual acceptance — needs the test machine** described in
  `CLAUDE.md`, with two accounts.

## Automated Tests Passing

**One command: `./scripts/run-tests.sh`** — 21 blocks, 270+ checks, all green.

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
- `browser/10`–`browser/16` — Phase 1 two-tab console flow (20), Phase 3.4
  renderer and counters (19), Phase 4.1 input capture and coordinate mapping
  (20), Phase 6 script pane and audit guardrails (21), Phase 5 elevation panel,
  banner and SAS (24), CSP enforced without breaking either page (22).
- Green **both** with and without `CONSOLE_PASSWORD`, i.e. against the
  authenticated console as deployed (D-008).
- `scripts/verify-deployment.sh` — 14 checks against the running container,
  including that the CSP survives the proxy rather than only leaving the app.
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

`git log --oneline -1` for the head, `git rev-list --count HEAD` for the count —
a hard-coded number here is wrong the moment the next commit lands, including
the commit that updates it.

As of 2026-09-04 the branch carries phases 0–7 plus two security reviews, and
the last fourteen commits are this session's work: Phase 5, its tests, the
cross-phase review's fixes, and the documentation recording both. Everything is
committed; the working tree is clean.

## GitHub Push Status

**SYNCHRONIZED.**

`origin` is `https://github.com/manojastro/helpdesk-anywhere-claude-Linux.git`,
authenticated through the `gh` CLI's credential helper. The first push sent the
whole of `main` — every commit from Phase 0 onward — and `main` now tracks
`origin/main`.

Verified after pushing, rather than assumed from the push's exit code:

```bash
git fetch origin
git rev-parse HEAD              # equals…
git rev-parse origin/main       # …this
git rev-list --left-right --count origin/main...main   # 0  0
```

No SHA or commit count is recorded here: it would be wrong the moment the next
commit lands, including the commit that writes it. Run the commands above.

Push conventions for this repo: no force push, no history rewriting, and no
token in the remote URL or anywhere in the tree.

The routine from here, at every stable milestone:
**code → build → test → update project memory → commit → push → verify push.**

## MT-06 — Secure Desktop: FAILED on real Windows, fixed, awaiting retest

**2026-09-05, mode A.** Elevation worked: the genuine UAC prompt for
`HelpdeskAnywhere.exe` appeared, the user clicked Yes, the desktop returned. A later
TeamViewer UAC prompt appeared correctly on the Windows Secure Desktop — and **the
technician canvas turned BLACK**, recovering when the prompt closed. Failed at
step 7 of MT-06; steps 8-11 and the whole of mode B were never reached.

**Root cause: desktop detection ran in session 0, where it cannot work.**
`DesktopWatcher` polled `OpenInputDesktop` inside the LocalSystem service.
That call resolves the input desktop of the calling process's window station, and
window stations are per-session — a session-0 service is on `Service-0x0-3e7$`,
which has no input desktop. The `Default → Winlogon` switch was structurally
invisible from there, so no helper ever reached the Secure Desktop and the applet
was never told to stop. A `BitBlt` of a desktop that no longer owns the display
**succeeds and returns black**, so the applet sent black keyframes and every layer
above treated them as a healthy stream.

**Status: FIX IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED · WINDOWS
RETEST REQUIRED.** MT-06 stays FAILED until the user retests.

What changed (`DECISIONS.md` D-010, `ARCHITECTURE.md`):

- the watch moved into the interactive session as its own process mode
  (`--desktop-watch`); the service keeps only the token dance across the session
  boundary, and the per-switch helper launch is now a plain `CreateProcess`;
- the applet detects the Secure Desktop itself and **suppresses** frames instead of
  sending black ones — with the whole elevated chain broken the canvas now freezes
  on the last true frame;
- the handoff between the two capturers is an explicit four-state machine, with a
  state for each gap in which neither source sends;
- elevation is reported only once the service is RUNNING, attached to the pipe, and
  its watcher has started — not merely registered;
- a four-process diagnostic log plus `scripts/mt06-diagnostics.ps1`, which prints a
  stage-by-stage verdict so one retest is enough.

Regression 23 blocks / 397 assertions / 0 failures. Application verified 14/14
directly against the container.

## ⚠ BLOCKED: the ngrok tunnel is out of bandwidth

`https://paternity-cannot-removal.ngrok-free.dev` returns **HTTP 403
`ERR_NGROK_725` — the ngrok account has reached its monthly network bandwidth
limit.** The Ubuntu stack is healthy and serving the correct binary; the ngrok edge
is refusing all traffic, and a restart will not help because the cap is monthly and
account-wide.

**No Windows retest is possible until the transport is restored** — the session's
frames travel the same tunnel as the download. Options, in order of preference:

1. **Move to DuckDNS + Caddy**, which is what `CLAUDE.md` specifies and
   `DECISIONS.md` D-007 always intended as the destination. Needs a DuckDNS
   subdomain and token in `.env`, ports 80/443 open on the VM (public IP
   92.4.69.40), then `./scripts/deploy.sh`. No bandwidth cap.
2. Wait for the ngrok monthly reset, or upgrade the plan.

## MT-01 — first real Windows run: FAILED, fixed, awaiting retest

**2026-09-05.** The first execution of `HelpdeskAnywhere.exe` on Windows never
reached `Main`. Windows refused the process at load:

> The application has failed to start because its side-by-side configuration is
> incorrect.

**Root cause, proven from the build artifacts.** `windows/Applet/app.manifest`
had `--install-service` inside an XML comment, and XML 1.0 section 2.5 forbids
`--` there. The RT_MANIFEST resource extracted from the shipped `.exe` was
byte-identical to that source file, so the malformed XML shipped exactly as
written. MSBuild's `<ApplicationManifest>` never parses the file — it copies the
bytes into the PE resource — which is why it cross-compiled cleanly, passed all 21
test blocks, and failed only in the one parser that cannot run on Linux.

**Status: FIX IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED · WINDOWS
RETEST REQUIRED.** MT-01 stays FAILED until the user runs the replacement binary;
a Linux build can prove the manifest is well-formed and nothing more.

The manifest is fixed and now carries an `<assemblyIdentity>`; elevation is
unchanged (`asInvoker` — constraint #1 puts consent first). `tests/lib/manifest.mjs`
and `tests/source/17-manifest.mjs` validate the source XML *and* the resource
inside the built `.exe`, and `scripts/build-windows.sh` refuses to publish an
invalid one. Detail in `CHANGELOG.md` and `DEV_NOTES.md`.

Replacement binary, rebuilt clean against the live tunnel:

| | |
|---|---|
| Path | `server/public/download/HelpdeskAnywhere.exe` |
| URL | `https://paternity-cannot-removal.ngrok-free.dev/download/HelpdeskAnywhere.exe` |
| Size | 65,903,057 bytes |
| SHA-256 | `20947ecbaa046532c74bb9a6bb3f6148e6ba3b1c534dfb3819410c1bff7f4968` |
| Endpoint | `wss://paternity-cannot-removal.ngrok-free.dev/ws` |

Regression 22 blocks / 0 failures · deployment verification 16/16 · audit 5/5.

## Exact Next Task

**Restore the transport first.** Everything below needs a reachable HTTPS/WSS
endpoint, and there is not one right now (see the ngrok block above). The
recommended move is DuckDNS + Caddy — the deployment `CLAUDE.md` actually specifies.
It needs a DuckDNS subdomain and token from the user.

Once there is an endpoint again:

1. Rebuild the .exe against the new hostname
   (`./scripts/build-windows.sh --server https://<host>`) — the endpoint is baked in.
2. **MT-06 retest, mode A.** Run `scripts/mt06-diagnostics.ps1 -Watch 40` alongside
   it and attach the log. This is the highest-value test: it is the feature the POC
   exists to prove, and it has now failed once.
3. **MT-01 retest** if it has not already passed — the applet's startup fix has not
   been confirmed on Windows either.
4. Then MT-05, MT-02, MT-03, MT-04, and MT-06 mode B (standard user, credential
   elevation), which has never been reached.

Record results in `MANUAL_TESTS.md`. Only the user may mark an MT as PASSED.
