# Changelog

All notable changes to Helpdesk Anywhere. Newest first.

Status vocabulary: `IMPLEMENTED`, `BUILD VERIFIED`, `AUTOMATED TEST VERIFIED`,
`LINUX INTEGRATION VERIFIED`, `MANUAL ACCEPTANCE PENDING`, `MANUAL ACCEPTANCE PASSED`.

---

## Cross-phase review — 2026-09-04

Status: AUTOMATED TEST VERIFIED (20 blocks, 250+ checks) · deployment
re-verified in Docker (12 + 5) · the TLS path verified locally for the first
time (9)

A review of phases 1–7 after Phase 5 landed, on the principle that code which
builds is not thereby correct. Seven findings, none of them in Phase 5 itself.

### Fixed

- **Teardown stopped capture last, not first.** Both teardown paths said "no
  frame may outlive the session" in a comment and then disposed the streamer
  fourth — after an SCM stop-and-wait and a process-tree kill. The user's screen
  kept going out over an open socket for the whole of that, after they had
  clicked End Session. Both paths now run in the order of the promises: stop
  sending pixels, release held keys and buttons, kill what the agent started,
  remove the elevated service.
- **A cross-thread race could abort teardown.** `InputInjector`'s held-key set is
  mutated from the UI thread and read from `Program.Teardown`, which runs on
  whatever thread crashed. A `HashSet` mutated from two threads can throw — and
  every teardown step was a bare statement, so a throw in step two meant the
  step that removes a LocalSystem service never ran. The state is now locked and
  every step is independently guarded.
- **SYSTEM scripts did not stream.** `ScriptRunner` flushes output every 250 ms;
  the elevated service's copy sent nothing until the process exited, so an
  `asSystem` script showed a blank pane for up to the full two-minute timeout.
- **`ALLOW_INSECURE_DEV` was only a warning.** It disables the check that keeps
  an administrator password off a plaintext wire. Now fatal on anything that
  looks like a real deployment.
- **Three settings could not be set at all.** `CREATE_ATTEMPTS_PER_MINUTE`,
  `MAX_LIVE_SESSIONS` and `ALLOWED_ORIGINS` were absent from compose's explicit
  environment block, so they were pinned to their defaults in every deployment.
- **`deploy.sh` had no console-password check** while `deploy-ngrok.sh` refused
  without one — and the TLS path is the more exposed of the two.
- **A placeholder passed for a secret.** Both deploy scripts checked only for
  emptiness, so an unedited `.env` started a stack that failed obscurely later.

### Added

- `input.sas` audit event. Ordinary mouse and key events are far too many to
  record, but the Secure Attention Sequence is reachable only after elevation and
  is the agent reaching the Windows security screen (constraint #5).
- `scripts/verify-tls-local.sh` — 9 checks against the real Caddy service and the
  real `Caddyfile`, using Caddy's internal CA. The permanent deployment path had
  never been exercised because it looked like it needed a DuckDNS token.
- `scripts/dev-local.sh` — the local stack as one command, with the
  `HOST_UID`/`HOST_GID` export that a hand-run compose silently needs.
- `build-windows.sh --server https://…`, converting the scheme and appending
  `/ws`, so an operator copies a printed URL instead of translating one.
- `scripts/lib/envfile.sh` — the `read_env`/`harden_env` pair that had been
  copied into three scripts, plus `looks_placeholder`.

---

## Phase 5 — UAC / Secure Desktop — 2026-09-04

Status: IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED where Linux can
reach (browser 24 checks, `ElevationErrorTests` 9, source invariants 25) ·
**WINDOWS MANUAL ACCEPTANCE PENDING — MT-06**

Nothing in this entry has executed on Windows. It cross-compiles; that is all a
Linux machine can say about it.

### Added

- **Elevation, both modes** (`PLAN.md` 5.2). Mode A relaunches the applet with the
  `runas` verb and Windows shows its own consent prompt; mode B uses
  `CreateProcessWithLogonW` so **no prompt appears on the end user's screen at
  all** — the case that matters on a managed fleet, where the user is not an
  administrator and must never be shown the admin password.
- **LocalSystem service + per-desktop helper** (5.3, 5.4). The service polls
  `OpenInputDesktop`, duplicates its own SYSTEM token into the console session and
  launches a helper bound to `WinSta0\Winlogon`, which captures and injects there
  with the same `GdiCapture`/`ScreenStreamer`/`InputInjector` the applet uses.
- **Named-pipe bridge** (5.5), ACL'd to LocalSystem and the session's user, carrying
  helper frames verbatim in the same `[0x01]`/`[0x02]` framing as the WebSocket.
- **`agent.input { kind:"sas" }`** (4.3) — Ctrl+Alt+Del as its own message, because
  no `SendInput` sequence can produce a Secure Attention Sequence. The console's
  button unlocks only after `host.elevated { ok:true }`.
- **`asSystem` scripts** now reach the elevated service instead of being refused.
- Console elevation panel: mode selector, credential fields cleared the instant they
  are sent, mapped error messages, "UAC prompt active" banner.
- One binary, three entry points (`DECISIONS.md` D-009) — the alternative was a
  ~160 MB download for a non-technical caller.

### Fixed during the Phase 5 review

- **The watchdog could never fire.** `PipeChannel.Exists` opened `\.\pipe` — a
  drive-relative path — instead of `\\.\pipe\`. It threw on every call, and a throw
  is read as "the applet is still there", so the backstop that guarantees constraint
  #4 when the applet is killed was dead code. Now correct, with a source-invariant
  test, and backed by a 12-hour absolute ceiling for the case where the check itself
  is unusable.
- **The staging directory inherited `%ProgramData%` permissions**, where any user may
  create subdirectories and `CREATOR OWNER` inherits full control — so a standard
  user could pre-create `%ProgramData%\HelpdeskAnywhere\`, own it, and replace the
  binary about to be registered as a LocalSystem service. It is now removed if
  present and re-created with a protected DACL (LocalSystem + Administrators).
- **A successful elevation could be reported as a failure.** The installer child is
  short-lived and `Process.GetProcessById` threw when it had already exited; the wait
  is now on the handle `CreateProcess` returned.
- **`lpCommandLine` was marshalled as a `string`.** The CreateProcess family may write
  to that buffer, and a Unicode `string` parameter is pinned rather than copied — so
  the callee was handed a pointer into the .NET string heap. Now `StringBuilder`.
- **A retried elevation could never connect.** A failed attempt disposed the pipe
  listener while keeping the manager, so the next attempt installed a service with
  nothing to talk to.
- The token was duplicated at `SecurityIdentification`; a primary token for
  `CreateProcessAsUser` wants `SecurityImpersonation`, and the wrong one is one of the
  two documented ways to get error 5 out of this sequence.
- Concurrent `asSystem` results could interleave their frames on the shared pipe.
- The indicator claimed "the agent ran a script as SYSTEM" even when the script had
  been refused for lack of elevation.
- Session end no longer waits on the 60-second watchdog: the applet asks the service
  to remove itself over the pipe, because it cannot delete a LocalSystem service
  itself.
- One elevation at a time, so a double-click cannot race two installers.

### Added — tests

- `tests/browser/14-phase5-elevation.mjs` (24 checks) — panel lifecycle, the password
  cleared on send and absent from `localStorage`/`sessionStorage`/the DOM, SAS as a
  message rather than a chord, the desktop banner.
- `tests/dotnet/ElevationErrorTests` (9 checks) — Win32 code → an actionable sentence.
- `tests/source/15-windows-invariants.mjs` (25 checks) — the properties a compiler
  cannot see and Linux cannot execute: no auto-start service, a pipe path that
  resolves, a password that reaches no log, a DACL that is not inherited.

---

## Security review — 2026-09-03

Status: AUTOMATED TEST VERIFIED (17 blocks, ~220 checks) · deployment
re-verified in Docker (12 checks) · `DEV_NOTES.md` → "Security review" carries
the full write-up

### Fixed

- **Console authentication could be walked around with path traversal.**
  `/download/../portal.html` and `/j/../portal.js` served the agent console with
  no credentials: the auth check matched the raw path against the routes the end
  user must reach openly, while `express.static` resolved the dots. The check now
  runs on a percent-decoded, normalised path.
- **The `/ws` upgrade accepted any browser Origin** — cross-site WebSocket
  hijacking. A foreign Origin is now refused with 403, while a client that sends
  no Origin at all (the applet, and every non-browser client) is still accepted.
- **`agent.create` had no rate limit and no ceiling.** Every create burns a code
  and writes an audit record, and with `CONSOLE_PASSWORD` unset anyone can reach
  it. Now `CREATE_ATTEMPTS_PER_MINUTE` (10/IP) and `MAX_LIVE_SESSIONS` (500).
- **A wire-supplied exec id chose the staged script's path.** `Path.Combine`
  discards its first argument when the second is rooted, so an id of
  `C:\Windows\Temp\x` — or `..\..\Startup\x` — staged and ran the script
  outside the session folder that teardown deletes, defeating constraint #4.
  `ScriptStaging.SafeFileName()` now confines it.
- The control-frame size cap counted UTF-16 units rather than bytes.
- Both deploy scripts chmod the `.env` to 600; it holds the console password and
  the ngrok authtoken and was world-readable.
- `docker-compose.local.yml`'s documented command omitted `HOST_UID`/`HOST_GID`,
  so a hand-run stack restart-looped on the audit-writable guard on any machine
  whose uid is not 1000.

### Added

- `tests/ws/07-security.mjs` — 14 regressions for the four defects above.
- `tests/dotnet/StagingTests` — 17 cases for the exec-id confinement.
- Two new checks in `scripts/verify-deployment.sh`: the traversal bypass is
  closed, and a foreign Origin is refused, both asserted against a live
  deployment.

---

## Regression suite promoted into the repo — 2026-09-03

Status: AUTOMATED TEST VERIFIED (15 blocks, ~190 checks, green in both the
unauthenticated and `CONSOLE_PASSWORD` configurations)

### Added

- `tests/` — every harness written during phases 1–6 now lives in the repo
  instead of a session scratchpad. Six protocol suites over raw WebSockets, four
  headless-Chrome suites driving the real console, and four `net8.0` unit suites
  that link the dependency-free C# classes (`AppletConfig`, `Protocol`,
  `TileGrid`, `KeyMap`) straight out of `windows/`.
- `tests/run-all.sh` (and `scripts/run-tests.sh`) — one runner, `--only ws |
  browser | dotnet` and `--no-browser`. Each block gets a **fresh server**,
  because the per-IP rate limiter and the code TTL are process state.
- `tests/setup-browser.sh` — installs Chrome for Testing and Puppeteer into
  `~/.cache/helpdesk-anywhere`, working around the two Ubuntu 24.04 snags
  recorded in `DEV_NOTES.md`. Neither is a dependency of the product, so neither
  is in `server/package.json` or the tree; the browser blocks **skip with a
  warning** when they are absent rather than failing the run.
- `tests/README.md` — a per-block table of what each suite actually proves.

### Changed

- The suites take their port, audit directory and server log from the
  environment (`HDA_TEST_PORT`, default 8099) instead of hard-coded `/tmp` paths
  and port 8080, so a run cannot disturb a dev server or the container.

### Why

The harnesses proved every Linux-side phase, then lived only in `/tmp` — one
reboot from being gone, and unrunnable by a fresh session. Nothing that guards
the six constraints should be that fragile.

---

## Phase 7 — Package, deploy, external access — 2026-09-03

Status: IMPLEMENTED · BUILD VERIFIED · LINUX INTEGRATION VERIFIED (the full stack
runs in Docker and the whole browser regression suite passes against it) ·
EXTERNAL ACCESS PENDING the user's ngrok token (`MANUAL_TESTS.md` → MT-05)

### Added

- Two interchangeable compose profiles over one identical `app` service: `ngrok`
  (temporary, no DNS) and `tls` (DuckDNS + Caddy). Migration is configuration only.
- `scripts/deploy-ngrok.sh` — build, start, wait for the tunnel, rebuild the applet
  against that URL, verify, and print the URLs.
- `scripts/verify-deployment.sh` — 10 checks incl. the `/ws` upgrade through the
  proxy and that the download really is a Windows binary.
- `scripts/verify-audit.sh` — audit integrity plus the constraint #6 scan for any
  credential-shaped field.
- `server/src/auth.ts` — shared-credential console authentication covering both the
  console page and its WebSocket (D-008).
- Security headers (nosniff, no-referrer, frame-deny), log rotation, service
  healthchecks and dependency ordering, `docker-compose.local.yml` for loopback
  smoke tests, and `DEPLOYMENT.md`.

### Fixed

- **The audit log silently failed in Docker.** The container ran as uid 1000 while
  the bind-mounted `./audit` belonged to another uid, so every write hit EACCES and
  left one line on stderr — constraint #5 broken in the deployed configuration.
  The container now runs as the directory's owner, and the server **refuses to
  start** if the audit log is not writable.
- `deploy.sh` and `verify-deployment.sh` no longer `source .env`: a `.env` is data,
  and sourcing executes any value containing a space or a backtick.

- `README.md`, `server/.dockerignore`, and a transient (auto-reverting) session
  indicator notice per PLAN 6.3.

### Verified

- 10 deployment checks, 5 audit checks, and the Phase 3/4/6 browser suites
  (19 + 20 + 21) re-run **against the containerised stack with console auth on**.
- Crash/restart behaviour, container health, and boot-time recovery.

---

## Phase 6 — Remote script execution — 2026-09-03

Status: IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED (console, streaming
protocol, audit guardrails) · WINDOWS MANUAL ACCEPTANCE PENDING
(`MANUAL_TESTS.md` → MT-04)

### Added

- `Scripting/ScriptRunner.cs` — stages the script to a per-session temp folder, runs
  PowerShell or cmd with both streams read asynchronously, flushes output every
  250ms, enforces a 120s timeout and a 1 MB output cap, and kills the whole process
  tree on timeout or session end.
- Console script pane: shell selector, Run-as-SYSTEM checkbox, streaming output with
  exit code, and a per-session run history.

### Changed — protocol (all three mirrors together)

- `host.execResult` gained an optional `partial` flag distinguishing a streamed chunk
  from the final result. `signaling.ts` now audits only the final one.

### Verified

- 21 checks: consent gating, frame shape, incremental rendering, exit-code handling,
  run history, markup-injection guard, and the two audit guarantees — full script
  text recorded *before* execution, exactly one `exec.result` per run.
- Phase 3 (19) and Phase 4 (20) harnesses re-run green after the console changes.

---

## Phase 4 — Remote input injection — 2026-09-03

Status: IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED (browser capture,
coordinate mapping, key table) · WINDOWS MANUAL ACCEPTANCE PENDING
(`MANUAL_TESTS.md` → MT-03)

### Added

- `Interop/Input.cs` — `SendInput`, `INPUT`/`MOUSEINPUT`/`KEYBDINPUT`, `MapVirtualKey`.
- `Input/KeyMap.cs` — DOM `event.code` → Windows VK, extended-key set, modifier set.
- `Input/InputInjector.cs` — absolute mouse positioning normalised to the 0–65535
  virtual-desktop space, scancode-based keyboard injection, and release-everything
  cleanup on session end, peer drop and crash.
- `portal.js` — mouse/key capture on the canvas, backing-store coordinate mapping,
  60/s move throttle, wheel sign inversion, blur release of held keys.
- `portal.html` — focusable canvas and the special-key buttons (Win, Alt+Tab,
  Ctrl+Esc, PrtScn, Ctrl+Shift+Esc), with Ctrl+Alt+Del disabled until Phase 5.

### Fixed

- A window-level `mouseup` sent a stray click into the user's desktop whenever the
  agent clicked any console button. Found by the new harness.

### Verified

- Browser input capture end-to-end — 20 checks, including that a centre click on a
  1600x900 remote shown in a 998px canvas maps to x=800 and not to the CSS x=499.
- `KeyMap` — 12 checks.

---

## Phase 3 — Screen capture + streaming — 2026-09-03

Status: IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED (renderer, tile
coalescing) · WINDOWS MANUAL ACCEPTANCE PENDING (`MANUAL_TESTS.md` → MT-02)

### Added

- `Interop/Gdi32.cs`, `Interop/User32.cs` — P/Invoke for capture, isolated in
  `Interop/` per the project conventions.
- `Capture/IScreenCapture.cs` — abstraction carrying the virtual-screen origin as
  well as its size, which Phase 4 input mapping needs.
- `Capture/GdiCapture.cs` — `BitBlt` capture with reused DC/bitmap handles, manual
  cursor compositing, and surface rebuild on a resolution or monitor change.
- `Capture/TileGrid.cs` — dirty-rect tile arithmetic, dependency-free so it is
  testable on Linux.
- `Capture/ScreenStreamer.cs` — 10 FPS capture→encode→send loop on its own thread,
  JPEG q60, FNV-1a tile diffing, 5-second keyframes, backpressure by skipping
  capture, and failure degradation.
- `portal.js` — canvas renderer for `[0x01]`/`[0x02]` frames with ordered async
  decode, plus the FPS/kbps counter.

### Verified

- Renderer end-to-end in headless Chrome against the real relay — 19 checks.
- `TileGrid` coalescing — 12 cases including a 200-grid random invariant.
- `dotnet build` — 0 warnings, 0 errors; publish produces a valid PE32+ .exe.

---

## Phase 2 — Windows applet: connect, code entry, consent — 2026-09-03

Status: IMPLEMENTED · BUILD VERIFIED · LINUX INTEGRATION VERIFIED ·
WINDOWS MANUAL ACCEPTANCE PENDING (`MANUAL_TESTS.md` → MT-01)

### Added

- `AppletConfig` — server URL baked in at publish time via `AssemblyMetadata`, URL
  normalisation (bare host → `wss:`), six-digit code validation.
- `SessionClient` — `ClientWebSocket` transport, dispatch loop, separate control and
  frame send queues, connect backoff, idempotent close.
- `AppletContext` — the code entry → consent → indicator → teardown flow.
- `CodeEntryForm`, `ConsentForm`, `IndicatorForm` (constraints #1, #2, #3).
- Global teardown wiring: process exit, unhandled exception, `Ctrl+C`,
  `SessionEnding`, `WM_QUERYENDSESSION`.
- Project memory: `PROGRESS.md`, `TASKS.md`, `MANUAL_TESTS.md`, `ARCHITECTURE.md`,
  `DECISIONS.md`, `CHANGELOG.md`.

### Changed

- `scripts/build-windows.sh` derives and bakes the server URL from
  `SERVER_URL` / `PUBLIC_HOST`.
- `Applet.csproj` — `ServerUrl` property, `AssemblyMetadata`, PerMonitorV2 DPI.

### Verified

- `dotnet build windows/HelpdeskAnywhere.sln -c Release` — 0 warnings, 0 errors.
- `AppletConfig` parsing — 22 cases pass (linked into a Linux `net8.0` harness).
- Applet wire frames replayed verbatim against the live relay — 12 checks pass.
- `npm --prefix server run typecheck` — clean.

---

## Phase 1 — Server: sessions, pairing, portal — 2026-09-02  (`744cb7f`)

Status: AUTOMATED TEST VERIFIED (71 checks, headless Chrome two-tab flow)

Session store with single-use 6-digit codes and TTL, WSS signaling and verbatim
relay with a consent gate, agent console, join page, JSONL audit log, and the
credential-elevation transport guard brought forward from Phase 5.

---

## Phase 0 — Environment + scaffold — 2026-09-02  (`b841323`)

Status: BUILD VERIFIED

Ubuntu toolchain (Node 22, Microsoft .NET 8 SDK, Docker), project scaffold, and proof
that `dotnet publish -r win-x64` produces a real `PE32+ executable (GUI) x86-64` from
Linux.
