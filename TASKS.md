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
[x] `verify-deployment.sh` — 16 checks, passing against the live ngrok tunnel
[x] WS checks forced to HTTP/1.1 — h2 cannot carry `Connection`/`Upgrade`
    (RFC 9113 §8.2.2), so curl was sending a bare GET and reading back a 401
[x] `GET /ws` without an upgrade answers 426, not the console's 401
[x] `deploy-ngrok.sh` writes the discovered tunnel host back to `PUBLIC_HOST`
    and restarts the app, so `/healthz`, the baked `.exe` URL and the Origin
    policy all agree with reality (`set_env` in `scripts/lib/envfile.sh`)
[x] `verify-audit.sh` — 5 checks, incl. the constraint #6 credential scan
[x] `DEPLOYMENT.md` operator guide; `.env.example` documents every key
[x] Secrets hygiene: `.env*` ignored, no secret in tree or history
[x] `README.md`, `server/.dockerignore`, transient indicator notice (PLAN 6.3)
[x] `scripts/dev-local.sh` — the local mode as a command, not a compose recipe
[ ] 7.2 DuckDNS hostname — needs an account token from the user
[ ] 7.4 Cloud firewall (80/443) — applies to the DuckDNS path only
[x] 7.8 First external deployment live and verified 16/16 at the HTTP/WS level
[M] **MT-05** — external access end to end over the tunnel (Windows half)
[M] 7.7 Internet end-to-end from a genuinely different network
[ ] Reserve an ngrok domain (`NGROK_URL`) so the URL survives a tunnel restart
    and the `.exe` need not be re-baked each time
[x] GitHub remote + credentials — `main` pushed and verified in sync

## Cross-cutting — regression suite  ✅

[x] Promote every phase-1..6 harness out of `/tmp` into `tests/`
[x] One runner: `./scripts/run-tests.sh` (`--only ws|browser|dotnet`, `--no-browser`)
[x] Fresh server per block — the rate limiter and code TTL are process state
[x] Port 8099 by default, so a run never disturbs the dev server or container
[x] Browser toolchain out of the tree, in `~/.cache/helpdesk-anywhere`; blocks
    skip with a warning when it is absent
[x] Whole suite green with and without `CONSOLE_PASSWORD` (D-008)
[x] `tests/README.md` — what each block actually proves

## Cross-cutting — cross-phase review (2026-09-04)  ✅

[x] Phases 1–7 re-read against the six constraints after Phase 5 landed
[x] Teardown stops capture first on both paths, each step independently guarded
[x] `InputInjector` held-state race fixed (UI thread vs. the crash path)
[x] SYSTEM scripts stream partial output like unelevated ones
[x] `ALLOW_INSECURE_DEV` fatal on anything that looks like a deployment
[x] `CREATE_ATTEMPTS_PER_MINUTE` / `MAX_LIVE_SESSIONS` / `ALLOWED_ORIGINS`
    reachable in a Docker deployment at all
[x] `deploy.sh` refuses an open console, as `deploy-ngrok.sh` already did
[x] Placeholder secrets refused by both deploy scripts
[x] `input.sas` audited — privileged, post-elevation, and rare enough to log
[x] TLS/Caddy path verified locally with Caddy's internal CA (9 checks)
[x] `npm audit` — 0 vulnerabilities; three qs advisories closed by an override

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
[x] Deployment re-verified in Docker with the two new checks (12 passing;
    16 as of the ngrok deployment)
[x] Content-Security-Policy — `script-src 'self'`, no nonce needed: the join
    page's inline script moved to `/join.js` (22 checks, `browser/16`)

## Cross-cutting — MT-01 Windows startup defect (2026-09-05)  ✅ fix landed, retest owed

The applet's first real Windows run failed in the loader with a side-by-side
activation error, before `Main`. Everything below is done; only the Windows
retest is outstanding, and only the user can do it.

[x] Root cause proven from the build artifacts rather than assumed from the
    message: `--` inside an XML comment in `windows/Applet/app.manifest`
    (XML 1.0 section 2.5), shipped verbatim into the PE's RT_MANIFEST resource
[x] Confirmed the embedded resource was byte-identical to the source, so no
    build step was corrupting it and no shell quoting was involved
[x] Ruled out, with evidence: dynamic manifest generation, `mt.exe` injection,
    single-file bundler interference, VC++ redistributable, architecture
    mismatch, a second manifested executable, side-by-side dependencies
[x] Manifest fixed; `asInvoker` preserved (constraint #1 — consent before
    elevation), `<assemblyIdentity>` added with `processorArchitecture="amd64"`
[x] `tests/lib/manifest.mjs` — strict XML scanner + PE RT_MANIFEST reader,
    dependency-free so the build script can use it too
[x] `tests/source/17-manifest.mjs` — 98 assertions: source XML, the manifest
    embedded in the built `.exe`, byte-equality of the two, and a negative case
    for every defect including the real one replayed from `153e449`
[x] `scripts/build-windows.sh` gates on it before *and* after `dotnet publish`
[x] Clean rebuild against the live endpoint; public download serves the
    replacement (sha256 verified over the public URL)
[ ] **MT-01 retest on Windows** — user only. The applet has never started; every
    other manual test is blocked behind it.

## Cross-cutting — MT-06 secure-desktop failure (2026-09-05)  ✅ fix landed, retest owed

The first real Windows run of Phase 5 mode A elevated correctly and then showed a
black technician canvas instead of the Secure Desktop. Everything below is done;
the Windows retest is outstanding and blocked on transport.

[x] Root cause proven from the source and Windows' window-station semantics:
    `OpenInputDesktop` polled from the session-0 service, where no input desktop
    exists — the `Default → Winlogon` switch was structurally invisible
[x] Second half proven too: `BitBlt` of a desktop that no longer owns the display
    succeeds and returns BLACK, so the applet sent black keyframes as if healthy
[x] Watch moved into the interactive session as `--desktop-watch` (D-010); the
    service keeps only the token dance across the session boundary
[x] Per-switch helper launch is now a plain `CreateProcess` + `lpDesktop`
[x] `DesktopGuard` — the applet detects the Secure Desktop itself and suppresses
    frames rather than sending black ones, conservatively (unknown means carry on)
[x] `StreamSource` — explicit four-state handoff, neither source sends in the gaps
[x] Elevation reports success only once the service is RUNNING + pipe attached +
    watcher attached, and names which precondition failed
[x] `DiagLog`/`DiagPaths` — four-process diagnostic log, shipped over the existing
    pipe into one user-readable file that outlives the service
[x] `scripts/mt06-diagnostics.ps1` — stage-by-stage verdict in one run
[x] `tests/source/18-secure-desktop.mjs` — 49 assertions, mutation-tested to fail
[x] ARCHITECTURE.md and DECISIONS.md updated — the architecture did change
[x] Clean rebuild; MT-01's manifest fix verified still intact in the new binary
[x] **Transport restored** — moved off ngrok (ERR_NGROK_725, monthly bandwidth
    cap) to a Cloudflare quick tunnel: `cloudflared` compose profile,
    `scripts/deploy-cloudflared.sh`, DECISIONS D-011. No account, no token, no
    cap; 16/16 through it, and a 66 MB download over it hashes correctly
[ ] **MT-06 retest on Windows** — user only. Nothing blocks it now.
[ ] DuckDNS + Caddy, so the hostname stops changing on every tunnel restart —
    needs a subdomain, a token, and ports 80/443 open on the VM

## Cross-cutting — MT-06 diagnostic script would not parse on Windows (2026-09-05)  ✅

[x] Root cause: six UTF-8 em dashes in a `.ps1` with no BOM. Windows PowerShell
    5.1 decodes such a file with the system ANSI code page, turning each dash
    into three characters whose last is U+201D — a smart quote PowerShell's
    tokenizer accepts as a STRING DELIMITER
[x] Reproduced exactly: reinterpreting the committed bytes as CP1252 produces the
    same five parse errors at the same five lines the Windows machine reported
[x] Body converted to pure ASCII, and a UTF-8 BOM added — either alone fixes it
[x] `tests/source/19-diagnostic-script.mjs` — 38 assertions, and it parses the
    file the way 5.1 would decode it, because a plain UTF-8 parse of the BROKEN
    file reported ZERO errors
[x] Asserts the diagnostic only observes: no UAC/Defender/registry/service
    changes, no self-elevation, no network, no credential or keystroke capture
[x] `scripts/publish-diagnostics.sh` — validate and secret-scan before publishing
[x] Republished through the live tunnel and verified: hash matches, BOM survives,
    served bytes parse with 0 errors. Tunnel not restarted, .exe not rebuilt

## Cross-cutting - MT-06 DesktopHelper crash loop (2026-09-05, second Windows run)  ~ fix landed, retest owed

[x] Cleared from source: mode dispatch (helper enters helper mode before WinForms),
    command line + quoting, and "no single-instance mutex" - so the helper is not
    silently becoming the applet or being killed as a duplicate
[x] Real exit code: watcher keeps the CreateProcess handle and reads
    GetExitCodeProcess + lifetime; the useless `exitCode=?` is gone
[x] Earliest helper logging: DiagLog.Start is the first statement (HELPER ENTRY
    REACHED + args), with a startup try/catch that logs type/message/stack, code 99
[x] Crash-loop ceiling: 5 rapid failures -> HELPER_STARTUP_FAILED, stop, backoff;
    reset on desktop change (no more ~300ms infinite respawn)
[x] No redundant helper on the applet's own Default desktop; still announce Default
[x] tests/source/20-helper-startup.mjs (33 assertions, mutation-tested)
[x] Rebuilt EXE vs current Cloudflare tunnel; MT-01 manifest intact; no stale endpoint
[ ] **MT-06 retest on Windows** - user only. If the Winlogon helper still exits, its
    real exit code (now logged) names the failing stage in one line.

## Cross-cutting - MT-06 SetThreadDesktop root cause (2026-09-05, third Windows run)  ~ fixed, retest owed

[x] exitCode=3 from the previous round's fix proved the stage: SetThreadDesktop,
    after OpenDesktop succeeded and before the pipe or capture
[x] Proven from Win32 semantics: STARTUPINFO.lpDesktop binds the process (and its
    primary thread) at creation, so the bind was redundant; and SetThreadDesktop
    fails on a thread owning a window, which [STAThread] guarantees before Main
[x] Helper now compares current vs target desktop at entry, skips the bind when
    already correct (DESKTOP_ALREADY_BOUND), switches only when it must, and logs
    the real GetLastWin32Error on failure
[x] Bound desktop VERIFIED before GdiCapture/InputInjector/ScreenStreamer (stage 5)
[x] Desktop handle lifetime follows Win32 (no handle when already bound; released
    on the failure branch; held while bound)
[x] Watcher labels helper exits as STAGES via DescribeHelperExit, not Win32 errors
[x] tests/source/20-helper-startup.mjs -> 47 assertions, mutation-tested
[ ] **MT-06 retest on Windows** - user only.
