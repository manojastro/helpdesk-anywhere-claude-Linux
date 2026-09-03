# Changelog

All notable changes to Helpdesk Anywhere. Newest first.

Status vocabulary: `IMPLEMENTED`, `BUILD VERIFIED`, `AUTOMATED TEST VERIFIED`,
`LINUX INTEGRATION VERIFIED`, `MANUAL ACCEPTANCE PENDING`, `MANUAL ACCEPTANCE PASSED`.

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
