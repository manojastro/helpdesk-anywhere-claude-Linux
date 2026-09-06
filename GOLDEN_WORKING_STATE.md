# Helpdesk Anywhere — Golden Working State

**Date:** 2026-09-06
**Status:** KNOWN-GOOD / REAL WINDOWS VERIFIED

This is a checkpoint, not a specification. It records what the code *actually does*
on the day the whole privileged remote-control flow was confirmed working on a real
Windows machine, and why it is shaped the way it is — so a future session can tell
a regression from an intended change without re-deriving four rounds of Windows
debugging.

Everything below was read from the source at the golden commit. Nothing here is
aspirational.

---

## 1. Working features

Normal remote support
- The applet launches (one-shot .exe, no install, no persistence).
- Six-digit session code connects through the relay.
- The end user's consent modal gates everything; nothing streams before Accept.
- Screen streaming works.
- Remote mouse works.
- Remote keyboard works.

Elevation
- The technician can request elevation from the console.
- The genuine Windows UAC prompt appears on the end user's screen.
- The user approves it.
- `HelpdeskAnywhereSvc` is created and started as LocalSystem.
- Service ↔ applet IPC over the per-session named pipe works.
- The in-session watcher attaches.

Secure Desktop
- `Default → Winlogon` transition is detected.
- The genuine UAC Secure Desktop is captured.
- It is visible in the technician console.
- Remote mouse works on the Secure Desktop.
- The technician can remotely click **Yes** on the genuine UAC prompt.
- UAC completes.
- `Winlogon → Default` transition works and normal streaming returns.

Post-UAC elevated application control
- After *Run as administrator → genuine UAC → remote Yes*, the elevated
  application opens on `WinSta0\Default`.
- The remote technician can interact with it: buttons, menus, and the ordinary
  Next / Back / Install / Finish flow of an elevated installer.

---

## 2. Real Windows acceptance results

These are **manual acceptance results from a real Windows machine**, reported by
the project owner. They are not simulated, and no Linux test can produce them.

| Item | Result |
|---|---|
| Applet launches | PASS |
| Session code connection | PASS |
| User consent | PASS |
| Normal screen streaming | PASS |
| Normal remote mouse | PASS |
| Normal remote keyboard | PASS |
| Technician requests elevation | PASS |
| Genuine Windows UAC appears | PASS |
| User approves initial elevation | PASS |
| `HelpdeskAnywhereSvc` starts | PASS |
| Service/app IPC | PASS |
| Watcher attaches | PASS |
| `Default → Winlogon` detected | PASS |
| Genuine UAC Secure Desktop captured | PASS |
| UAC visible in technician console | PASS |
| Remote mouse on Secure Desktop | PASS |
| Remote click **Yes** on genuine UAC | PASS |
| UAC completes | PASS |
| `Winlogon → Default` return | PASS |
| Normal desktop streaming returns | PASS |
| **Post-UAC elevated application control** | **PASS** |
| **Elevated installer Next/Back/Install/Finish** | **PASS** |

Not yet accepted, and deliberately still open: **MT-04** (real PowerShell script
execution, streamed output, timeout, tree kill) and the formal **MT-05** network
test. MT-05's substance — an HTTPS download of the .exe over the public tunnel and
a full session across it — is exercised by every run above, but its formal step
list has not been walked, so it stays PENDING rather than being quietly upgraded.

---

## 3. UAC Secure Desktop architecture

UAC renders on a **separate desktop** (`Winlogon`) inside the **same session**. A
process running as the interactive user cannot open, capture or inject into it, and
that isolation *is* the security boundary — it is what stops malware from clicking
a consent prompt on the user's behalf. Reaching it legitimately requires SYSTEM.

```
Applet.exe (interactive user, Medium integrity)
   │  agent requests elevation
   ▼
--install-service            elevated once; stages %ProgramData%, CreateService, StartService
   ▼
--run-service   (LocalSystem, session 0)
   │  does the ONE thing only session 0 can: SE_TCB_NAME + move a SYSTEM token
   │  across the session boundary. It supervises, it does not watch desktops.
   ├─ CreateProcessAsUser ─► --desktop-watch   (SYSTEM, interactive session,
   │                            │                lpDesktop = WinSta0\Default)
   │                            │  polls OpenInputDesktop every 150ms — works HERE,
   │                            │  and only here
   │                            ├─ CreateProcess ─► --desktop-helper
   │                            │                     (SYSTEM, same session,
   │                            │                      lpDesktop = WinSta0\<desktop>)
   │                            └─ named pipe ────► applet: desktop transitions, diagnostics
   └─ named pipe ──────────► applet: `asSystem` scripts, teardown request
```

**Why the watch is a separate process in the user's session.** `OpenInputDesktop`
resolves the input desktop of the window station associated with the *calling
process*, and window stations are per-session. A session-0 service is on
`Service-0x0-3e7$`, which has no input desktop at all — so polling it from the
service could never see the interactive session switch to `Winlogon`, and never
did. That was MT-06's original black-canvas failure. See `DECISIONS.md` D-010.

**Why a helper process per desktop.** Thread desktop association is inherited from
the **process** (`STARTUPINFO.lpDesktop` at creation), not from the creating
thread. That is what makes one-process-per-desktop reliable: `ScreenStreamer`'s
loop awaits, its continuations land on thread-pool threads, and those threads are
on the process's desktop automatically. Merging the watcher and helper would need
an explicit `SetThreadDesktop` after every continuation — a rule nothing enforces.

**Why the helper does not call `SetThreadDesktop` when it does not need to.**
`lpDesktop` already bound the process at creation, and `SetThreadDesktop` fails on
a thread that owns a window — which `[STAThread]` guarantees, because OLE creates
its hidden message window before `Main` is entered. The helper therefore compares
its current desktop to the target, skips the bind when they match
(`DESKTOP_ALREADY_BOUND`), switches only when they differ, and **verifies** the
result before creating any capture surface (`DESKTOP_VERIFIED`). A capture bound to
the wrong desktop does not error — it produces a perfect picture of the wrong
screen, which is the least detectable failure in this project.

---

## 4. Elevated Default-desktop input architecture

This is a **third state**, and merging it with the Secure Desktop is how it gets
misdiagnosed:

| | Desktop | Target | Injector that works |
|---|---|---|---|
| A | `WinSta0\Default` | ordinary window | applet, or the elevated helper |
| B | `WinSta0\Winlogon` | Secure Desktop | secure-desktop helper |
| C | `WinSta0\Default` | **elevated window** | an injector above Medium integrity |

State C is *not* the Secure Desktop. The desktop is ordinary and the applet
captures it perfectly well; only **input into that one window** is refused.

**Why.** Windows UIPI (User Interface Privilege Isolation) discards synthetic input
sent from a process at a lower integrity level than the window receiving it. The
applet is **Medium** integrity by design — `asInvoker`, `uiAccess="false"`, and
CLAUDE.md constraint #1 requires consent before anything, so it must never
self-elevate. A post-UAC target is **High**. `SendInput` returned `0` with
`ERROR_ACCESS_DENIED`, into a return value the code used to discard.

**How it is solved.** The boundary is crossed by privilege, not by removing it. The
session watcher keeps a helper on `WinSta0\Default` too, launched `--input-only`.
It runs as **SYSTEM**, in the interactive session, on the same desktop — above both
Medium and High — so its `SendInput` is accepted by ordinary and elevated windows
alike. One injector therefore covers states A and C, which also keeps a per-event
token query off the input path at mouse-move rates.

`--input-only` is load-bearing: the applet already captures Default, and the
redundant second capturer removed earlier must not return. An input-only helper
creates no device contexts and no full-screen bitmap; `ScreenBounds` supplies only
the virtual-screen geometry `InputInjector` needs to map a remote pixel, read live
so a mid-session resolution change cannot misplace every click.

---

## 5. Relevant Windows components / classes

One binary, four modes (`DECISIONS.md` D-009). What is staged in
`%ProgramData%\HelpdeskAnywhere\` is a copy of the same `.exe`.

| File | Responsibility |
|---|---|
| `windows/Applet/Program.cs` | Entry point and **mode dispatcher**: `--run-service`, `--desktop-helper`, `--desktop-watch` are dispatched *before* any WinForms init; then `--install-service`, `--uninstall-service`, else the applet UI |
| `windows/Applet/AppletContext.cs` | The session: code entry → consent → indicator → teardown; **input routing**; stream-source state machine; elevation requests |
| `windows/Applet/SessionClient.cs` | WSS transport to the relay |
| `windows/Applet/Forms/*.cs` | Code entry, consent modal, always-visible session indicator |
| `windows/Applet/Capture/GdiCapture.cs` | GDI screen capture; consults `DesktopGuard` before `BitBlt` |
| `windows/Applet/Capture/DesktopGuard.cs` | "Does this thread's desktop still own the display?" — stops black frames |
| `windows/Applet/Capture/StreamSource.cs` | Four-state handoff: `DefaultDesktop`, `SecureDesktopTransition`, `SecureDesktop`, `ReturningToDefault`. Exactly one source may send |
| `windows/Applet/Capture/ScreenStreamer.cs` | Capture → JPEG → sink, dirty-rect tiles, backpressure |
| `windows/Applet/Capture/ScreenBounds.cs` | Geometry-only `IScreenCapture` for the input-only helper (no DCs, no bitmap) |
| `windows/Applet/Input/InputInjector.cs` | `SendInput` mouse/keyboard; tracks accepted vs attempted and raises `DeliveryChanged` when UIPI refuses |
| `windows/Applet/Interop/ForegroundTarget.cs` | Foreground window's pid, image name, **integrity level**, elevation — read-only, generic, fails closed |
| `windows/Applet/Interop/Desktops.cs` | `OpenInputDesktop`, `OpenDesktop`, `SetThreadDesktop`, `GetThreadDesktop`, `SendSAS` |
| `windows/Applet/Elevation/ElevationManager.cs` | Both bootstrap modes; reports success only once the SYSTEM half is **usable** |
| `windows/Applet/Elevation/ServiceControl.cs` | Create/start/stop/delete the service; `IsRunning()` |
| `windows/Applet/Elevation/ElevationPayload.cs` | Stages the .exe into `%ProgramData%` with a protected, non-inherited DACL |
| `windows/Applet/Elevation/SecureDesktopBridge.cs` | The applet's pipe **server**; tracks `service` / `watcher` / `helper` endpoints separately; forwards helper frames; routes input |
| `windows/SecureDesktopService/Program.cs` | Service entry, SCM status, watchdog, self-uninstall |
| `windows/SecureDesktopService/DesktopWatcher.cs` | Session-0 **supervisor**: keeps one session watcher alive; the token dance across the session boundary |
| `windows/SecureDesktopService/SessionWatcher.cs` | `--desktop-watch`: polls `OpenInputDesktop` **in-session**; keeps one helper per input desktop; real exit codes; crash-loop ceiling |
| `windows/SecureDesktopService/WatcherLink.cs` | Watcher's pipe to the applet: early desktop transitions + diagnostics |
| `windows/SecureDesktopService/ServiceLink.cs` | Service's pipe to the applet: `asSystem` scripts, session-over |
| `windows/SecureDesktopService/Interop/SessionLaunch.cs` | `DuplicateTokenEx` → `SetTokenInformation(TokenSessionId)` → `CreateProcessAsUser`; plain `CreateProcess`; process handle/exit-code calls |
| `windows/DesktopHelper/Program.cs` | `--desktop-helper`: desktop bind decision, verification, capture (secure desktops) and/or input injection |
| `windows/Shared/PipeChannel.cs` | Length-prefixed framing, tags, roles, and the pipe **ACL** |
| `windows/Shared/DiagLog.cs`, `DiagPaths.cs` | Four-process diagnostic log; elevated processes ship lines to the applet's copy |

---

## 6. Service / helper relationships

```
HelpdeskAnywhereSvc  (LocalSystem, session 0, SERVICE_DEMAND_START)
  ├── supervises exactly one  --desktop-watch  (SYSTEM, interactive session)
  │     └── supervises exactly one  --desktop-helper  (SYSTEM, per input desktop)
  └── connects to the applet's pipe as role "service"
```

* The service **never** injects input or draws UI. Session 0 has no desktop the
  user can see; its only unique power is `SE_TCB_NAME` and moving a duplicated
  SYSTEM token into another session.
* The watcher is replaced if it dies or if the active console session changes.
* The helper is replaced on every desktop change, and restarted if it dies —
  bounded: a helper up less than 2s counts as a rapid failure, and five in a row on
  one desktop logs `HELPER_STARTUP_FAILED` and stops relaunching until the desktop
  changes, with a growing backoff in between.
* Teardown: the applet asks over the pipe; the service self-uninstalls. The
  watchdog (pipe absent for 60s) and a 12-hour lifetime ceiling are the backstops.
  Nothing survives the session; nothing survives a reboot.

---

## 7. Desktop transitions

```
Default ──user triggers UAC──► Winlogon ──user/technician answers──► Default
```

1. `SessionWatcher` sees the input desktop change (150ms poll, in-session).
2. It announces the new desktop to the applet **immediately**, before launching
   anything — the applet stops streaming its own desktop at once, which is what
   closes the window in which it used to send black frames.
3. It stops the old helper and starts one on the new desktop.
4. The helper binds (or confirms it is already bound), verifies, connects, and —
   on a secure desktop — captures and streams.
5. The applet's `StreamSource` moves `DefaultDesktop → SecureDesktopTransition →
   SecureDesktop`, and back through `ReturningToDefault`. In both transition states
   **neither** source sends: a frozen last frame is honest, a black one is not.
6. On return to `Default` the helper for `Default` is input-only, so the applet
   resumes its own capture.

---

## 8. Input routing behavior

```
Technician → relay → applet (AppletContext.RouteInput)
   │
   ├── kind == "sas"      → bridge → helper → SendSAS()          (never a synthesised chord)
   │
   ├── bridge.TrySendInput(json) == true   → the attached SYSTEM helper injects
   │        · on Winlogon: the secure-desktop helper   (STATE B)
   │        · on Default:  the --input-only helper     (STATES A and C)
   │
   └── otherwise → applet's own InputInjector.SendInput  (fallback, Medium integrity)
```

**Exactly one injector handles each event.** `TrySendInput` both decides and
delivers and returns false only when no helper is attached, so there is no window
in which both could run and a click could land twice.

The route is logged **on change**, never per event: `NORMAL_DEFAULT_INPUT`,
`ELEVATED_DEFAULT_INPUT`, `SECURE_DESKTOP_INPUT`, together with the foreground
window's pid, image name and integrity. If an elevated window is in the foreground
and no elevated route exists, the log says `UIPI WILL REFUSE THIS INPUT` and the
user's own indicator says so once.

---

## 9. Security boundaries

Preserved, deliberately, and regression-sensitive:

* **UAC is genuine.** Not bypassed, not suppressed, not simulated. The prompt the
  technician sees is the real one Windows drew.
* **The Secure Desktop stays enabled.** It is reached with SYSTEM privilege, which
  is the supported way, rather than by weakening the isolation.
* **UIPI is untouched.** No `uiAccess="true"`, no `ChangeWindowMessageFilter`, no
  global hooks, and the target's integrity is never lowered. The elevated route
  works because the injector is entitled to inject, not because the boundary moved.
* **Nothing auto-clicks.** The technician's own click is the only source of a
  consent decision. Ctrl+Alt+Del goes to `SendSAS` — no injected key sequence can
  produce a Secure Attention Sequence, and none is attempted.
* **The applet never self-elevates.** `asInvoker`, `uiAccess="false"`. Elevation is
  a separate, separately-consented step.
* **Consent first, always.** Nothing streams before Accept; the indicator is
  always visible; the user can end the session in one click.
* **Credentials are never logged, retained or buffered.** The password arrives as
  `char[]`, is zeroed in a `finally` on every path including the exception path, is
  never converted to a `string`, and credential-mode elevation is hard-refused over
  a non-TLS connection.
* **Diagnostics carry no input.** No coordinates, keys, text, script bodies,
  session codes or credentials — asserted at the call sites by the test suite.
* **No persistence.** Demand-start service, installed at session start, uninstalled
  at session end, staging directory removed. Nothing survives a reboot.

---

## 10. IPC architecture

A single per-session named pipe, `HelpdeskAnywhere-<guid>`, created by the applet.

* **ACL:** LocalSystem and the session's own user. Nobody else — not other
  logged-on users. A world-writable pipe carrying input into a SYSTEM process
  would be a local privilege-escalation hole.
* **Name:** per-session GUID on the applet's command line to the service. Nothing
  about it outlives the session.
* **Roles:** each client's first frame is a `Hello` naming itself — `service`,
  `watcher` or `helper`. The applet tracks all three separately, so input is never
  routed to a process that injects nothing.
* **Framing:** 4-byte big-endian length prefix + payload. Video tags are the *same
  bytes* as the WebSocket protocol, so helper frames are forwarded to the relay
  verbatim — no decode, no re-encode.
* **Liveness:** the pipe's existence is the session heartbeat. Sixty seconds of
  absence and the service uninstalls itself.

---

## 11. Build procedure

Cross-compiled from Ubuntu; **Windows code cannot be run-tested here**.

```bash
./scripts/build-windows.sh --server https://<current-public-host>
```

It validates the embedded application manifest **before** publishing and again on
the produced binary, then drops the .exe into `server/public/download/`.

```bash
./tests/run-all.sh                       # full regression
dotnet build windows/HelpdeskAnywhere.sln -c Release   # Windows components
```

The `WFAC010` high-DPI warning is expected and correct to ignore: the manifest DPI
declaration is what applies before any managed code runs, which is what capture
coordinates need.

**Builds are not byte-reproducible.** A .NET single-file publish embeds
non-deterministic data, so rebuilding the same commit yields a different SHA-256.
The source is what the golden commit pins; the hash identifies one specific build.

---

## 12. Deployment procedure

```bash
./scripts/deploy-cloudflared.sh
```

Builds and starts the stack on the `cloudflared` profile, waits for the tunnel,
writes the assigned hostname into `.env` as `PUBLIC_HOST`, restarts the app so that
hostname is the one it reports and accepts on `/ws`, rebuilds the applet with the
matching `wss://` endpoint baked in, and runs `verify-deployment.sh`. It refuses to
start with an open console.

---

## 13. Current Cloudflare deployment method

A Cloudflare **quick tunnel** (`DECISIONS.md` D-011): no account, no token, no DNS,
no bandwidth cap. It replaced ngrok, which hit its monthly bandwidth limit and
blocked testing entirely — a 66 MB binary per test plus a live video stream is the
wrong shape for that free tier.

**The hostname is random and changes on every restart of the tunnel.** The applet
dials a URL baked in at build time, so a restarted tunnel silently orphans every
`.exe` already downloaded — it launches and then never connects. Re-run
`./scripts/deploy-cloudflared.sh`; it reconciles `PUBLIC_HOST` and rebuilds the
`.exe` together.

Read the live hostname without restarting anything:

```bash
curl -s http://127.0.0.1:2000/quicktunnel
docker compose --profile cloudflared logs cloudflared | grep trycloudflare
```

Still a stopgap. D-007's destination is unchanged: DuckDNS + Caddy.

---

## 14. How the Windows EXE receives its relay endpoint

Compiled in at publish time (`DECISIONS.md` D-004), so the end user types nothing
but six digits:

```
scripts/build-windows.sh --server https://<host>
   → converts https:// to wss:// and appends /ws
   → dotnet publish -p:ServerUrl=wss://<host>/ws
   → <AssemblyMetadata Include="ServerUrl" Value="$(ServerUrl)"/>   (Applet.csproj)
   → AppletConfig.DefaultServerUrl reads that metadata at runtime
```

The code-entry form can still override it for development. Verify what a built
binary will dial:

```bash
strings -a windows/Applet/bin/Release/net8.0-windows/win-x64/Applet.dll \
  | grep -oE 'wss://[a-zA-Z0-9.-]+/ws' | sort -u
```

(The single-file bundle is compressed, so read the intermediate assembly, not the
final `.exe`.)

---

## 15. Automated test status

At the golden commit, on Linux:

| Suite | Result |
|---|---|
| `./tests/run-all.sh` | **26 blocks, 523 assertions, 0 failures** |
| `dotnet build windows/HelpdeskAnywhere.sln -c Release` | 0 errors, 1 expected warning (`WFAC010`) |
| `./scripts/verify-deployment.sh https://<host>` | **16 / 16** |
| `./scripts/verify-audit.sh` | **5 / 5** |
| `npm --prefix server audit --omit=dev` | 0 vulnerabilities |

The Windows-specific blocks are source invariants, not execution — the compiler is
the only other automated feedback for `windows/`:

* `15-windows-invariants.mjs` — constraints #2/#4/#6, teardown ordering, ACLs
* `17-manifest.mjs` — the application manifest, in source *and* in the built PE
* `18-secure-desktop.mjs` — the secure-desktop chain
* `19-diagnostic-script.mjs` — `mt06-diagnostics.ps1` parses under PowerShell 5.1
* `20-helper-startup.mjs` — helper startup, exit codes, backoff, desktop binding
* `21-elevated-input.mjs` — the three input states and the UIPI diagnostics

Every one of these was mutation-tested: the invariant was broken on purpose and the
block confirmed to go red.

---

## 16. Manual test status

`MANUAL_TESTS.md` is authoritative. At this checkpoint:

| Test | Covers | Status |
|---|---|---|
| MT-01 | Connect, code, consent, indicator, disconnect | **PASSED** (real Windows) |
| MT-02 | Capture, streaming | **PASSED** (real Windows) |
| MT-03 | Mouse, keyboard, no stuck modifiers | **PASSED** (real Windows) |
| MT-04 | Real PowerShell, streamed output, timeout, tree kill | PENDING |
| MT-05 | External network, TLS, download, whole flow | PENDING (substantially exercised) |
| MT-06 | UAC / Secure Desktop, mode A | **PASSED** (real Windows) |
| MT-06 | mode B — standard user, credential elevation | PENDING (never reached) |

---

## 17. Known limitations

* **MT-06 mode B has never been run.** Credential-mode elevation (standard user +
  separate admin credentials) is implemented and Linux-tested but not manually
  accepted. This is the realistic corporate case.
* **MT-04 is unaccepted.** `asSystem` script execution has not been manually run.
* **The tunnel hostname is volatile.** Every restart orphans downloaded binaries.
* **The binary is unsigned.** SmartScreen and Defender will flag it; that detection
  is correct behaviour for an unsigned binary that runs as SYSTEM and injects
  input. The test machine needs an explicit path exclusion. Any real deployment
  needs proper code signing — do not attempt to evade AV.
* **Builds are not byte-reproducible** (see §11).
* **Single-monitor testing only.** Multi-monitor and DPI-scaled paths are
  implemented (`PerMonitorV2`, virtual-screen origin) but not manually accepted.
* **The console has a shared password, not per-agent identity** (`PLAN.md` puts
  that out of scope; `DECISIONS.md` D-008).

---

## 18. Important diagnostic log references

Do not delete this history; each entry is a defect that shipped and the signal that
found it.

* `C:\Users\manoj\Downloads\hda-20260906-002545-applet-34992.log` — the reference
  run that established: service startup worked, watcher worked, session 5 was
  correct, `Default → Winlogon` detection worked, `DesktopHelper` was created, and
  the helper then crash-looped. Both the Default and Winlogon helper paths needed
  fixes as a result.
* A later run showed the helper launching on `Winlogon`, `exitCode=3`, a lifetime
  of ~320–336ms, five rapid failures, and `HELPER_STARTUP_FAILED` bounded-retry
  protection engaging exactly as designed. `exitCode=3` is the helper's **stage**
  code for `SetThreadDesktop` — that one number is what identified the root cause.
* Live logs during a session: `%LOCALAPPDATA%\HelpdeskAnywhere\logs\` (the applet's
  unified copy, which outlives the service) and
  `%ProgramData%\HelpdeskAnywhere\logs\` (the elevated processes' own copy, deleted
  with the staging directory).
* `scripts/mt06-diagnostics.ps1` reads both and prints a stage-by-stage verdict.

All of those failures are **fixed**. They are recorded because the *shape* recurs:
three separate MT-06 defects were a Windows API succeeding from the caller's point
of view while doing nothing (`BitBlt` returning black, a discarded child exit code,
`SendInput` refused by UIPI).

---

## 19. Recovery procedure

See §24 for the exact commands. In short: the golden tag and the golden branch both
point at the same commit; check one out, rebuild against the *current* tunnel
hostname (the old one will be dead), and republish.

---

## 20. Golden Git commit

A commit cannot contain its own hash, so the canonical identifier is the tag.
Resolve the exact commit with:

```bash
git rev-list -n 1 hda-windows-privileged-control-working-2026-09-06
```

The hash is also written into the annotated tag's own message
(`git show hda-windows-privileged-control-working-2026-09-06`), and
`golden/windows-privileged-control-2026-09-06` points at the same commit.

## 21. Golden Git tag

`hda-windows-privileged-control-working-2026-09-06` (annotated, pushed to origin)

## 22. Golden branch

`golden/windows-privileged-control-2026-09-06` (pushed to origin)

Development continues on `main`. Do not commit to the golden branch.

## 23. Binary SHA-256

| | |
|---|---|
| Golden binary | `HelpdeskAnywhere-GOLDEN-2026-09-06.exe` |
| Location | `~/hda-artifacts/HelpdeskAnywhere-GOLDEN-2026-09-06.exe` (outside the repo, read-only) |
| Size | 65,918,222 bytes |
| SHA-256 | `435bbe5fc9569cb81a8738f2ac5d2c010ae86d44bb11f24e7666a42ca84a8c0c` |
| Built (UTC) | 2026-09-06T02:45:17Z |
| Baked endpoint | `wss://sarah-wanted-councils-lewis.trycloudflare.com/ws` |

Binaries are **not tracked in Git** (`.gitignore`: `server/public/download/*.exe`),
and that policy is unchanged for this checkpoint. The golden binary is reproducible
from the golden commit — though not byte-identical (§11):

```bash
git switch -c restore-golden hda-windows-privileged-control-working-2026-09-06
./scripts/build-windows.sh --server https://<current-host>
```

**The binary the owner manually accepted** was an earlier build of the *same
source*, SHA-256
`5ff9764663e2016b91fc46ea036939ea8c842af049bc53b8f246536d02a48a40`
(65,918,210 bytes). It was replaced in the download directory by this golden
rebuild. Both were produced from the golden commit's source; the hashes differ only
because the publish is non-deterministic. A copy of the accepted binary may still
exist on the Windows test machine.

---

## 24. Restoring this exact working version

**View the golden version**

```bash
git show hda-windows-privileged-control-working-2026-09-06
```

**Check it out into a temporary branch**

```bash
git switch -c restore-golden hda-windows-privileged-control-working-2026-09-06
```

**or use the recovery branch directly**

```bash
git switch golden/windows-privileged-control-2026-09-06
```

**Compare a future `main` against golden** — the first thing to do if privileged
control regresses:

```bash
git diff hda-windows-privileged-control-working-2026-09-06..main
git diff hda-windows-privileged-control-working-2026-09-06..main -- windows/
```

**Rebuild and republish from golden**

```bash
curl -s http://127.0.0.1:2000/quicktunnel          # the CURRENT hostname
./scripts/build-windows.sh --server https://<current-host>
sha256sum server/public/download/HelpdeskAnywhere.exe
```

No destructive `git reset` is suggested, and none is needed: the tag and the branch
are independent, immutable references to the same commit.
