# Changelog

All notable changes to Helpdesk Anywhere. Newest first.

Status vocabulary: `IMPLEMENTED`, `BUILD VERIFIED`, `AUTOMATED TEST VERIFIED`,
`LINUX INTEGRATION VERIFIED`, `MANUAL ACCEPTANCE PENDING`, `MANUAL ACCEPTANCE PASSED`.

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
