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

## Phase 3 — Screen capture + streaming  🔵

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

## Phase 4 — Remote input injection  ⚪

[ ] 4.1 Browser → wire mouse/key events, remote-pixel mapping
[ ] 4.2 `SendInput` injection, absolute coordinates on the virtual desktop
[ ] 4.3 Special keys, modifiers, Ctrl+Alt+Del limitation documented
[M] Windows acceptance

## Phase 5 — UAC / secure desktop  ⚪ (stretch)

[ ] 5.1–5.7 per `PLAN.md`
[ ] Elevation surfaced on the session indicator (`IndicatorForm.ShowNotice`)
[ ] Credential zeroing, no logging, non-TLS hard refusal (server side done)
[M] Windows acceptance, both elevation modes, two accounts

## Phase 6 — Remote script execution  ⚪

[ ] 6.1 `ScriptRunner`, streamed output
[ ] 6.2 Console UI
[ ] 6.3 Guardrails + audit before execution (server side done)
[M] Windows acceptance

## Phase 7 — Package, TLS, deploy, internet test  ⚪

[ ] 7.1 Docker image + compose bring-up
[ ] 7.2 DuckDNS hostname
[ ] 7.3 Caddy TLS
[ ] 7.7 Internet end-to-end from a different network
[!] GitHub remote + credentials — needs the user (`PROGRESS.md` → Blockers)
