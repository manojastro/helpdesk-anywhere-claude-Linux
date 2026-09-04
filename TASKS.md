# Helpdesk Anywhere — Task Backlog

```
[ ] not started   [~] in progress   [x] done (validated)
[M] manual acceptance pending   [!] blocked   [D] deferred
```

A task is `[x]` only when it has been validated, not merely written.

---

## Phase 0 — Environment + scaffold  ✅

[x] Node 22 / .NET 8 (Microsoft SDK) / Docker toolchain
[x] Project scaffold per `PLAN.md`
[x] Cross-compile proof — `PE32+ executable (GUI) x86-64`

## Phase 1 — Server: sessions, pairing, portal  ✅

[x] `shared/protocol.md` + both mirrors
[x] Session store, 6-digit single-use codes, 10-minute TTL
[x] WSS signaling + verbatim relay, consent gate, heartbeat
[x] Agent console, join page, JSONL audit log
[x] Credential-elevation transport guard (moved earlier — `DEV_NOTES.md`)
[x] Acceptance — 71 checks, headless Chrome two-tab flow

## Phase 2 — Applet: connect, code entry, consent  🟡

[x] `Applet.csproj` single-file self-contained publish
[x] Server URL baked at publish time (`AssemblyMetadata` + `build-windows.sh`)
[x] `AppletConfig` — URL normalisation, code validation (22 cases pass)
[x] `SessionClient` — WSS transport, dual send queues, backoff, teardown
[x] Code-entry form (`PLAN.md` 2.2 step 1)
[x] Consent dialog (step 2, constraint #1)
[x] Session indicator (step 3, constraints #2/#3)
[x] Cleanup guarantee — `Teardown()` on exit/crash/Ctrl+C/`WM_QUERYENDSESSION`
[x] Wire-frame replay against the live relay (12 checks pass)
[M] **MT-01** — Windows end-to-end acceptance

## Phase 3 — Screen capture + streaming  🟡

[x] 3.1 `IScreenCapture` abstraction + GDI `BitBlt` implementation
[x] 3.1 Virtual-desktop bounds and origin (multi-monitor), cursor compositing
[x] 3.2 JPEG encode (q60) + `[0x01]` full-frame send at 10 FPS
[x] 3.2 Capture loop lifecycle — starts only after consent, stops on teardown
[x] 3.3 Dirty-rect diffing + `[0x02]` tile frames (`TileGrid`, 12 cases pass)
[x] 3.4 Browser render into `<canvas>` + FPS/kbps counter (19 checks pass)
[x] 3.6 Continuous streaming under backpressure (skip capture when a frame is queued)
[x] 3.7 Disconnect cleanup — capture stops first on every teardown path
[x] 3.8 Error handling — capture failure degrades to a notice on the indicator
[~] 3.9 Performance measurement — counter shipped; real numbers need Windows
[M] **MT-02** — Windows end-to-end acceptance: live desktop at >=8 FPS

## Phase 4 — Remote input injection  🟡

[x] 4.1 Browser → wire mouse/key events, remote-pixel mapping (20 checks pass)
[x] 4.1 Move throttling, wheel sign/quantisation, contextmenu suppression
[x] 4.2 `SendInput` injection, absolute coords on the virtual desktop
[x] 4.2 `KeyMap` event.code → VK, extended-key flags (12 checks pass)
[x] 4.2 Modifier/button release on session end, peer drop and crash
[x] 4.3 Special-key buttons: Win, Alt+Tab, Ctrl+Esc, PrtScn, Ctrl+Shift+Esc
[x] 4.3 Ctrl+Alt+Del button present but disabled until Phase 5 (SAS limitation)
[M] **MT-03** — Windows end-to-end acceptance: cursor accuracy, drag, typing

## Phase 5 — UAC / secure desktop  🟣 (stretch — implemented)

[x] 5.1 Three processes, one binary — `--run-service` / `--desktop-helper` (D-009)
[x] 5.2a Mode A: `runas` relaunch, Windows' own consent prompt, once per session
[x] 5.2b Mode B: `CreateProcessWithLogonW`, no prompt on the user's screen at all
[x] 5.2b Win32 error → an actionable sentence (`ElevationErrors`, 9 checks pass)
[x] 5.2c Password as a zeroed `char[]`; unmanaged copy zeroed before free; never
    logged, never retained for a retry; one gap recorded (`DEV_NOTES.md`)
[x] 5.2d Payload staged to `%ProgramData%` with a protected DACL, service created
    `SERVICE_DEMAND_START`, started, and removed again
[x] 5.3 LocalSystem service: SCM plumbing by P/Invoke, desktop polling at 200 ms,
    `DuplicateTokenEx` → `SetTokenInformation(TokenSessionId)` → `CreateProcessAsUser`
[x] 5.4 `DesktopHelper`: `SetThreadDesktop` first, then the *same* `GdiCapture`,
    `ScreenStreamer` and `InputInjector` behind `IFrameSink`
[x] 5.5 Named-pipe framing shared with the WS protocol; ACL'd to LocalSystem and
    the session's own user; helper frames forwarded verbatim
[x] 5.6 Desktop switch → `host.desktopChanged`, console banner, local capture
    paused, keyframe forced on resume
[x] 5.7 Two independent uninstall routes + a 12-hour ceiling; no reboot-deferred
    cleanup anywhere
[x] 4.3 Ctrl+Alt+Del as `kind:"sas"`, enabled only after `host.elevated{ok:true}`
[x] 6.1 `asSystem` scripts routed to the service; refused clearly when unelevated
[x] Elevation surfaced on the session indicator (`IndicatorForm.ShowNotice`)
[x] Console elevation panel, both modes, credentials cleared on send (24 checks)
[x] Phase 5 review — eleven defects found and fixed (`CHANGELOG.md` → Phase 5)
[M] **MT-06** — Windows acceptance, both elevation modes, two accounts

## Phase 6 — Remote script execution  🟡

[x] 6.1 `ScriptRunner` — temp staging, async stream reads, 120s timeout, tree kill
[x] 6.1 Streamed partial output (`partial` flag added to all three protocol mirrors)
[x] 6.1 `asSystem` refused with a clear error until Phase 5 exists
[x] 6.2 Console script pane: shell selector, output, exit code, run history
[x] 6.3 Full script text audited before execution; only the final result audited
[x] 6.3 Indicator notice on the user's machine; 1 MB output cap
[M] **MT-04** — Windows end-to-end acceptance: real PowerShell, streaming, timeout

## Phase 7 — Package, TLS, deploy, internet test  🔵

[x] 7.1 Docker image, compose profiles, healthchecks, log rotation
[x] 7.1 Container runs as the audit directory's owner; fail-fast if unwritable
[x] 7.3 Caddy config for the permanent path (HSTS, download route)
[x] 7.8 ngrok profile + `deploy-ngrok.sh` — temporary external access, no DNS
[x] Console authentication (page + WebSocket), `DECISIONS.md` D-008
[x] Security headers: nosniff, no-referrer, frame-deny
[x] `verify-deployment.sh` — 10 checks, passing against the container
[x] `verify-audit.sh` — 5 checks, incl. the constraint #6 credential scan
[x] `DEPLOYMENT.md` operator guide; `.env.example` documents every key
[x] Secrets hygiene: `.env*` ignored, no secret in tree or history
[x] `README.md`, `server/.dockerignore`, transient indicator notice (PLAN 6.3)
[x] `scripts/dev-local.sh` — the local mode as a command, not a compose recipe
[ ] 7.2 DuckDNS hostname — needs an account token from the user
[ ] 7.4 Cloud firewall (80/443) — applies to the DuckDNS path only
[M] **MT-05** — external access end to end over the tunnel
[M] 7.7 Internet end-to-end from a genuinely different network
[!] GitHub remote + credentials — needs the user (`PROGRESS.md` → Blockers)

## Cross-cutting — regression suite  ✅

[x] Promote every phase-1..6 harness out of `/tmp` into `tests/`
[x] One runner: `./scripts/run-tests.sh` (`--only ws|browser|dotnet`, `--no-browser`)
[x] Fresh server per block — the rate limiter and code TTL are process state
[x] Port 8099 by default, so a run never disturbs the dev server or container
[x] Browser toolchain out of the tree, in `~/.cache/helpdesk-anywhere`; blocks
    skip with a warning when it is absent
[x] Whole suite green with and without `CONSOLE_PASSWORD` (D-008)
[x] `tests/README.md` — what each block actually proves

## Cross-cutting — Windows source invariants  ✅

The Windows half compiles here and executes nowhere here, so the compiler is the
only automated grip on it — and a compiler is happy with a pipe path that throws,
a service that starts at boot, or a password on its way into a log.

[x] `tests/source/15-windows-invariants.mjs` — 25 checks against constraints
    #2, #4 and #6 plus the PLAN 5.3/5.4/5.5 ordering rules
[x] Registered in the runner as its own block (`--only source`)
[x] Verified to FAIL when the invariant is broken, not merely to pass

## Cross-cutting — security review  ✅

[x] Full read of server, console and applet against the six constraints
[x] S-1 console-auth path-traversal bypass — fixed, regression test
[x] S-2 cross-site WebSocket hijacking (no Origin check) — fixed, regression test
[x] S-3 `agent.create` unbounded — per-IP limit + live-session ceiling
[x] S-4 wire-supplied exec id escaped the session temp folder — `ScriptStaging`
[x] Control-frame cap measured in bytes, not UTF-16 units
[x] `.env` chmod 600 in both deploy scripts
[x] Deployment re-verified in Docker with the two new checks (12 passing)
[ ] Content-Security-Policy — needs a nonce for the join page's inline script;
    recorded as a known limitation in `server/src/index.ts`
