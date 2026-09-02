# Helpdesk Anywhere — End-to-End Build Plan

Read `CLAUDE.md` first for architecture and the hard Ubuntu/Windows testing boundary.

Work through phases in order. **Each phase ends with an acceptance test. Do not
proceed until it passes.** Tests marked 🪟 must be run by a human on the Windows test
machine — stop and ask.

Estimated total: **~4.5–6 weeks** for one developer. Phase 5 (UAC) is ~30% of that and
is the highest-risk item; if it slips, everything else still demos.

---

## Phase 0 — Ubuntu environment + scaffold  ✅ **DONE** (2026-09-02)
**~0.5 day**

### Install prerequisites
```bash
sudo apt update && sudo apt install -y curl git build-essential
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
sudo apt install -y docker.io docker-compose-v2 && sudo usermod -aG docker $USER

# .NET: use Microsoft's build, NOT `apt install dotnet-sdk-8.0` — see below.
curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
chmod +x /tmp/dotnet-install.sh && /tmp/dotnet-install.sh --channel 8.0 --install-dir "$HOME/.dotnet"
cat >> ~/.bashrc <<'EOF'
export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$HOME/.dotnet:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
EOF
```

> ⚠ **Do not use Ubuntu's `dotnet-sdk-8.0` package.** It ships without
> `Microsoft.NET.Sdk.WindowsDesktop`, so every `UseWindowsForms` project fails to
> even load: *"The imported project …/Microsoft.NET.Sdk.WindowsDesktop.targets was
> not found."* That kills `Applet` and `DesktopHelper`. Microsoft's SDK from
> `dotnet-install.sh` includes it. If the apt package is already installed, remove
> it (`sudo apt remove dotnet-sdk-8.0 dotnet-host`) so there is only one `dotnet`
> on PATH. *(Verified on Ubuntu 24.04.4 / apt SDK 8.0.130 vs Microsoft SDK 8.0.424.)*

Log out/in for the docker group. Verify: `node -v` (v22.x), `dotnet --version` (8.x),
`docker ps`, and
`ls $DOTNET_ROOT/sdk/*/Sdks/Microsoft.NET.Sdk.WindowsDesktop` (must exist).

### Create this structure
```
helpdesk-anywhere/
├── CLAUDE.md, PLAN.md
├── docker-compose.yml, Caddyfile, .env.example, .gitignore
├── shared/protocol.md
├── scripts/{build-windows.sh,dev-server.sh,deploy.sh}
├── server/
│   ├── Dockerfile, package.json, tsconfig.json
│   ├── src/{index.ts,config.ts,protocol.ts,sessions.ts,signaling.ts,audit.ts}
│   ├── src/routes/{portal.ts,download.ts}
│   └── public/{portal.html,portal.js,portal.css,join.html,download/.gitkeep}
└── windows/
    ├── HelpdeskAnywhere.sln
    ├── Shared/{Shared.csproj,Protocol.cs,PipeChannel.cs}
    ├── Applet/{Applet.csproj,Program.cs,...}
    ├── SecureDesktopService/{SecureDesktopService.csproj,Program.cs,...}
    └── DesktopHelper/{DesktopHelper.csproj,Program.cs,...}
```

**Acceptance:** `npm --prefix server ci && npm --prefix server run build` succeeds;
`dotnet build windows/HelpdeskAnywhere.sln` succeeds on Ubuntu (compile only).

✅ **Passed 2026-09-02.** Both halves clean (0 warnings, 0 errors). Additionally
verified early: `./scripts/build-windows.sh` produces a real
`PE32+ executable (GUI) x86-64, for MS Windows`, confirming the cross-compile claim
in `CLAUDE.md` before any Phase 2 work depends on it. Added
`EnableCompressionInSingleFile` to `Applet.csproj` — the self-contained single-file
.exe is 139 MB without it, 63 MB with, and this is a file a non-technical user
downloads mid-support-call.

---

## Phase 1 — Server: sessions, pairing, portal
**~2–3 days**

### 1.1 Protocol (`shared/protocol.md` + both mirrors)
Single WSS endpoint `/ws`. First message declares role. JSON for control; binary
frames for video (first byte = frame type, remainder = JPEG payload).

Agent → server:
```
{ t:"agent.create" }                         → { t:"session.created", code:"482913" }
{ t:"agent.input", kind:"mouse"|"key", ... }
{ t:"agent.exec", shell:"powershell"|"cmd", script:"...", asSystem:bool }
{ t:"agent.requestElevation", mode:"interactive" }
{ t:"agent.requestElevation", mode:"credential",
  domain:"...", username:"...", password:"..." }   // NEVER logged — see 5.2b
{ t:"agent.end" }
```
Host (applet) → server:
```
{ t:"host.join", code:"482913", machine:"...", user:"...", os:"..." }
{ t:"host.consent", accepted:bool }
{ t:"host.desktopChanged", desktop:"Default"|"Winlogon"|"Screen-saver" }
{ t:"host.elevated", ok:bool, error?:"..." }
{ t:"host.execResult", id:"...", exitCode:int, stdout:"...", stderr:"..." }
<binary> [0x01][jpeg bytes]  // full frame
<binary> [0x02][x:u16][y:u16][w:u16][h:u16][jpeg bytes]  // dirty rect (Phase 3.3)
```
Server → both: `{ t:"peer.joined"|"peer.left"|"error", ... }`, plus
`{ t:"host.connectRequest", agentName:"..." }` to the host and
`{ t:"consent.result", accepted:bool }` to the agent.

### 1.2 Session store (`sessions.ts`)
In-memory `Map<code, Session>` — no database for the POC.
- 6-digit numeric codes from `crypto.randomInt`. Reject on collision, retry.
- `Session = { code, agentWs, hostWs, state, createdAt, consentedAt, hostInfo }`
- `state`: `waiting_for_host` → `waiting_for_consent` → `active` → `ended`
- **Codes expire after 10 minutes unused**, and are single-use — burn on host join.
- Rate-limit `host.join` to 5 attempts per IP per minute; a 6-digit code is only
  ~1M wide, so unlimited guessing is a real hijack path even in a POC.
- Sweep expired/ended sessions on a 60s timer.

### 1.3 Signaling + relay (`signaling.ts`)
Pure pass-through: relay control JSON and binary frames between the paired sockets.
Enforce state machine — drop any frame arriving before `state === "active"`.
Close both sides when either drops. Heartbeat ping every 20s, drop dead peers.

### 1.4 Agent console (`public/portal.html` + `portal.js`)
- "Start session" button → shows the code large, plus a copyable join URL
  (`https://<name>.duckdns.org/j/482913`).
- Status line reflecting the state machine ("Waiting for user…", "Awaiting consent…",
  "Connected").
- `<canvas>` for the remote screen (Phase 3), a script pane (Phase 6), an
  "Unlock UAC prompts" control (Phase 5), and an "End session" button.
- The "Unlock UAC prompts" control offers both elevation modes (Phase 5.2):
  *"User is an administrator — ask them to approve"* and *"Enter admin credentials"*
  (domain / username / password). The credential form must use `type="password"`,
  `autocomplete="off"`, must never be written to `localStorage`/`sessionStorage`, and
  its fields must be cleared immediately after send.
- Banner when `host.desktopChanged` reports `Winlogon`: **"UAC prompt active"**.

### 1.5 Join page (`public/join.html`)
Served at **`/j/:code`** (path-style, not `?code=` — it is much easier to read aloud on
a support call). Express route `app.get("/j/:code", ...)` serves the page; the client
reads the code from `location.pathname`. Shows the code, a big **Download** button
(`/download/HelpdeskAnywhere.exe`), and explicit numbered instructions:
`1. Download → 2. Open the file (click "More info → Run anyway" if Windows warns)
→ 3. Enter code ###### → 4. Click Accept.` This page is what stops non-technical
users getting stuck — write it as plainly as possible.

### 1.6 Audit log (`audit.ts`)
Append-only JSONL to a mounted volume: session created/joined/consent/ended, every
`agent.exec` with its full script text, every elevation request.

**Acceptance:** With `npm run dev`, open two browser tabs. Tab 1 creates a session and
shows a code. A mock host (write `scripts/mock-host.js`, a tiny `ws` client) joins with
that code, receives `connectRequest`, replies `consent:true`; Tab 1 flips to
"Connected". Wrong code is rejected; a code reused twice is rejected; 6 rapid bad
attempts are rate-limited.

---

## Phase 2 — Windows applet: connect, code entry, consent
**~2 days**

### 2.1 Projects
`Applet.csproj`: `net8.0-windows`, `<UseWindowsForms>true</UseWindowsForms>`,
`<Nullable>enable</Nullable>`, `<PublishSingleFile>true</PublishSingleFile>`,
`<SelfContained>true</SelfContained>`, `<RuntimeIdentifier>win-x64</RuntimeIdentifier>`,
`<IncludeNativeLibrariesForSelfExtract>true</IncludeNativeLibrariesForSelfExtract>`.

`scripts/build-windows.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
dotnet publish windows/Applet/Applet.csproj \
  -c Release -r win-x64 --self-contained true \
  -p:PublishSingleFile=true -p:EnableWindowsTargeting=true \
  -o /tmp/hda-publish
cp /tmp/hda-publish/Applet.exe server/public/download/HelpdeskAnywhere.exe
echo "→ server/public/download/HelpdeskAnywhere.exe"
```
`EnableWindowsTargeting=true` is **required** to build a WinForms/Windows-targeted
project from Linux; without it the SDK refuses.

### 2.2 UI flow (`Program.cs`, `Forms/`)
1. **Code entry form** — server URL (pre-baked from `config`, overridable), 6-digit
   code box, Connect button, clear error text on bad/expired code.
2. **Consent dialog** — *"[Agent name] is requesting to view and control this
   computer."* Accept / Decline. Topmost, centered, cannot be dismissed by Esc.
   Decline → send `consent:false`, close cleanly.
3. **Session indicator** — after Accept, a small always-on-top borderless window:
   red dot, "Screen is being shared with [agent]", **End Session** button. Position
   bottom-right, no close box, cannot be minimised away. This is constraint #2 in
   `CLAUDE.md` — it is a feature, not chrome.

### 2.3 Transport (`SessionClient.cs`)
`System.Net.WebSockets.ClientWebSocket` to `wss://<server>/ws`. Send `host.join` with
`Environment.MachineName`, `Environment.UserName`, OS version. Dispatch loop for
control messages; separate send queue so video frames never block control. Reconnect
with backoff on transient drop, but **hard-stop and exit** if the session is ended.

### 2.4 Cleanup guarantee
Register handlers for process exit, `Ctrl+C`, `WM_QUERYENDSESSION` and unhandled
exceptions that call one idempotent `Teardown()` — stop capture, uninstall the service
(Phase 5), close sockets, remove temp files. A crash must never leave a SYSTEM service
behind.

**Acceptance 🪟:** Build on Ubuntu, download the .exe on the Windows VM from the join
page, run it, type the code from the agent console. Consent dialog appears naming the
agent; Accept flips the console to "Connected" and the indicator window appears;
Decline closes the applet and the console shows "declined". End Session from the
indicator tears down both sides.

---

## Phase 3 — Screen capture + streaming
**~4–5 days**

### 3.1 Capture abstraction
`IScreenCapture { Bitmap Grab(); Size Bounds { get; } }`, implemented by
`GdiCapture` — `CreateDC("DISPLAY")` / `CreateCompatibleDC` / `CreateCompatibleBitmap`
/ `BitBlt(SRCCOPY | CAPTUREBLT)`, plus `GetSystemMetrics(SM_CXVIRTUALSCREEN/SM_CY…)`
for multi-monitor extents. Also blit the cursor manually via `GetCursorInfo` +
`DrawIconEx` (BitBlt does not include it).

**Use GDI, not DXGI Desktop Duplication, and do not "upgrade" later without
re-testing Phase 5.** DXGI is faster but does not work on the Winlogon/Secure Desktop,
which is the single most important feature in this project. GDI works on every desktop.
Reuse the DC/bitmap handles across frames — recreating them per frame is the usual
cause of a GDI capture running at 3 FPS.

### 3.2 Encode + send
Encode to JPEG via `System.Drawing.Imaging` with an `EncoderParameter` quality of 60
(tune 40–75). Target 8–10 FPS on a fixed timer; **skip the frame if the previous send
has not completed** so a slow link degrades frame rate instead of building an unbounded
queue. Send as `[0x01][jpeg]` binary WS frames.

### 3.3 Dirty-rect optimisation (do this only once 3.2 works)
Split into a grid of 128×128 tiles, hash each tile (xxHash or a cheap FNV over the
locked `BitmapData` rows), send only changed tiles as `[0x02][x][y][w][h][jpeg]`. Send
a full keyframe every 5s and on any client resize. This typically cuts bandwidth 10–20×
on a mostly-static desktop and is what makes the difference between "usable" and
"laggy" — but it is an optimisation, so get full frames working first.

### 3.4 Browser render (`portal.js`)
`ws.binaryType = "arraybuffer"`; on `0x01`, `createImageBitmap(new Blob([...]))` →
`ctx.drawImage(bmp,0,0)`; on `0x02`, draw into the given rect. Scale the canvas with
CSS to fit, but keep the backing store at native remote resolution so input coordinate
mapping stays exact. Display an FPS/kbps counter — you will need it for tuning.

**Acceptance 🪟:** The Windows VM's live desktop renders in the agent's browser at
≥8 FPS, cursor visible, correct on a multi-monitor VM, and legible text. Moving a
window updates smoothly. Sustained bandwidth reported in the counter.

---

## Phase 4 — Remote input injection
**~2–3 days**

### 4.1 Browser → wire
Capture `mousemove` (throttled to ~60/s), `mousedown/up` (all 3 buttons), `wheel`,
`dblclick`, `contextmenu` (suppress the browser's own menu), `keydown/keyup` on the
canvas. Map canvas coordinates → remote pixels using the backing-store ratio, **not**
the CSS size. Send DOM `event.code` (physical key) rather than `event.key`, so layout
differences don't scramble input.

### 4.2 Applet → Win32 (`Input/InputInjector.cs`)
`SendInput` with `INPUT` structs.
- Mouse: `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE`, with
  coordinates normalised to the 0–65535 virtual-desktop space
  (`x * 65535 / virtualWidth`). Getting this wrong is the usual cause of "the cursor
  lands in the wrong place on multi-monitor".
- Keyboard: map `event.code` → Windows VK via an explicit table; use
  `KEYEVENTF_SCANCODE` with scancodes from `MapVirtualKey` for best compatibility, and
  set `KEYEVENTF_EXTENDEDKEY` for the extended set (arrows, Ins/Del/Home/End/PgUp/PgDn,
  right Alt/Ctrl, numpad Enter/Divide).
- Track modifier state server-side-of-the-applet and **release all held modifiers on
  session end or peer drop** — a stuck Ctrl on the user's machine after disconnect is a
  nasty failure mode.

### 4.3 Special keys
`Ctrl+Alt+Del` cannot be injected by `SendInput` at all (it is a Secure Attention
Sequence, reserved by the kernel). Provide it as an explicit console button that is
**disabled until Phase 5 elevation succeeds**, then implemented from the elevated
service via `SendSAS()` from `sas.dll`. Also add console buttons for Win, Alt+Tab,
Ctrl+Esc, PrintScreen, since browsers swallow those.

**Acceptance 🪟:** From the browser the agent can move the cursor accurately (verify at
all four screen corners and on a second monitor), click, right-click, drag, scroll,
type into Notepad including symbols/arrows/Backspace, and use Alt+Tab via the button.
Disconnecting mid-drag leaves no stuck button or modifier.

---

## Phase 5 — UAC / Secure Desktop  ⚠ highest risk
**~5–7 days**

This is the feature the whole POC exists to prove. Read this phase fully before
writing code.

### 5.1 Why it needs a separate process
UAC consent renders on a **separate desktop** (`Winlogon`) inside the same session.
A process running as the interactive user cannot open, capture, or inject into it —
that isolation *is* the security boundary. To reach it you need a thread running as
**SYSTEM**, attached to the `Winlogon` desktop, **inside the user's session** (not
session 0). Hence three processes:

```
Applet.exe (user)                  ← WS to server, UI, user-desktop capture
   │ installs + starts (once, after one UAC prompt)
   ▼
SecureDesktopService.exe (SYSTEM, session 0)
   │ watches for input-desktop changes; CreateProcessAsUser into user session
   ▼
DesktopHelper.exe (SYSTEM, user's session, lpDesktop="Winlogon")
   │ captures + injects on the secure desktop
   └── named pipe ──► Applet.exe ──► server ──► agent
```

### 5.2 One-time elevation bootstrap — two modes

Installing the service requires admin rights, and how you get them depends on the end
user's account. **Both modes must be implemented** — mode B is the one that matters on
a managed corporate fleet.

What the end user's account type changes:
- **Local admin** → UAC shows a *consent* prompt (just Yes/No, no password).
- **Standard user** → UAC shows a *credential* prompt demanding an admin username and
  password, which the end user does not have.

#### 5.2a Interactive mode — end user is a local admin
`agent.requestElevation { mode:"interactive" }`. The applet relaunches itself with
`ProcessStartInfo { UseShellExecute = true, Verb = "runas",
Arguments = "--install-service --pipe <name>" }`. Windows shows its native consent
prompt and **the end user clicks Yes locally, once per session.** Console UI should say
exactly that: *"Ask the user to approve the Windows prompt on their screen."* Handle
`Win32Exception` 1223 (user cancelled) → `host.elevated { ok:false, error:"declined" }`
and keep the session running unelevated.

#### 5.2b Credential mode — end user is a standard user ⭐
This is the important one. Without it the tool deadlocks on any locked-down machine:
the bootstrap prompt is itself a *credential* prompt on the Secure Desktop, the end user
cannot fill it in, and the agent cannot yet see it — because the service that would make
it visible is exactly what is being installed.

`agent.requestElevation { mode:"credential", domain, username, password }`. The agent
types admin credentials into **their own browser console**; the applet receives them and
launches the installer directly:

```csharp
// No UAC prompt appears — credentials are supplied programmatically.
CreateProcessWithLogonW(
    username, domain, password,
    LOGON_WITH_PROFILE,            // 0x00000001
    appletPath, "--install-service --pipe " + pipeName,
    CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
    IntPtr.Zero, null, ref si, out pi);
```

Fall back to `LogonUser(..., LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT)` +
`CreateProcessAsUser` if `CreateProcessWithLogonW` proves awkward (it can be fussy
about the target station/desktop; set `si.lpDesktop = @"WinSta0\Default"`).

Map errors to clear console messages rather than raw codes — 1326 `ERROR_LOGON_FAILURE`
(bad username/password), 1327 (blank passwords not allowed), 1331 (account disabled),
1385 `ERROR_LOGON_TYPE_NOT_GRANTED` (account lacks interactive-logon right), 1909
(account locked out). "Wrong password" vs "this account can't log on interactively" are
very different problems for the agent to act on.

**The payoff:** the agent never reveals the admin password to the end user, the end user
clicks nothing, and from this point the agent can see *and type into* every subsequent
UAC credential prompt remotely.

#### 5.2c Credential handling rules — mandatory, not optional
This is the most security-sensitive code in the project: a mishandled buffer here leaks
domain admin credentials.

1. **TLS is mandatory.** Refuse `mode:"credential"` entirely if the connection is not
   `wss:`. This is the second and stronger reason for the DuckDNS decision in Phase 7 —
   over plain HTTP an admin password would cross the public internet in cleartext.
2. **Never logged, anywhere.** Not the audit log, not server logs, not
   `console.log`, not exception messages or stack traces. Audit the *fact* and *result*
   of an elevation attempt plus the username — never the password. Add an explicit
   redaction step in the server's message logger keyed on the `agent.requestElevation`
   type, so a future verbose-logging change cannot leak it by accident.
3. **Relay retains nothing.** Forward in memory only; never buffer, queue, or persist.
   Note honestly that the relay *can* see the plaintext — for anything past a POC,
   end-to-end encrypt this payload to a key the applet generates at session start so a
   compromised server cannot read it. Track as a known POC limitation.
4. **Zero the buffer.** Use `char[]`/`SecureString` on the applet side where the API
   allows, overwrite with zeros in a `finally`, and never hold credentials past the
   single `CreateProcessWithLogonW` call. Do not retain them for later re-elevation.
5. **Visible to the end user.** The session indicator must show *"The agent is
   elevating privileges on this computer"*. The user consented to being helped, not to
   silent privilege escalation — constraint #2 in `CLAUDE.md` applies here most of all.
6. **Rate-limit attempts** to 5 per session and audit every failure. An unauthenticated
   portal plus unlimited credential attempts turns this tool into an online password
   guesser against the end user's domain.

#### 5.2d The elevated installer (both modes converge here)
Writes `SecureDesktopService.exe` to `%ProgramData%\HelpdeskAnywhere\`, creates the
service via `CreateService` (`SERVICE_WIN32_OWN_PROCESS`, `SERVICE_DEMAND_START`,
LocalSystem), starts it, reports success back over the pipe, then exits.

### 5.3 The service (`SecureDesktopService`)
Runs as LocalSystem in session 0. Loop:
1. `hDesk = OpenInputDesktop(0, false, GENERIC_ALL)` — the currently *active* desktop.
2. `GetUserObjectInformation(hDesk, UOI_NAME, …)` → `"Default"` / `"Winlogon"` /
   `"Screen-saver"`.
3. On change, ensure a `DesktopHelper` is running for that desktop; kill the helper for
   the old one.
4. Poll at ~200ms. (An event-driven `SetWinEventHook(EVENT_SYSTEM_DESKTOPSWITCH)` needs
   a hook in the interactive session; polling is far simpler and 200ms is imperceptible
   here. Do not over-engineer this.)

To launch the helper **as SYSTEM but in the user's session**:
- `WTSGetActiveConsoleSessionId()` → target session.
- `OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE|TOKEN_QUERY, out hTok)` on the
  service's own SYSTEM token.
- `DuplicateTokenEx(hTok, MAXIMUM_ALLOWED, ref sa, SecurityIdentification,
  TokenPrimary, out hDup)`.
- `SetTokenInformation(hDup, TokenSessionId, ref sessionId, sizeof(uint))` — this is
  the step that moves a SYSTEM token into the interactive session, and it only works
  *because* the caller is SYSTEM with `SE_TCB_NAME`.
- `CreateEnvironmentBlock` for the target.
- `STARTUPINFO.lpDesktop = @"WinSta0\Winlogon"` (or `WinSta0\Default`).
- `CreateProcessAsUser(hDup, exe, args, …, CREATE_UNICODE_ENVIRONMENT |
  CREATE_NO_WINDOW, env, null, ref si, out pi)`.

Common failure: `CreateProcessAsUser` returns 5 (access denied) → you duplicated the
wrong token or skipped the session-id set. Returns 0x5A7 / desktop errors → the
`lpDesktop` string is wrong; it must include the window-station prefix.

### 5.4 The helper (`DesktopHelper`)
Args: `--desktop Winlogon --pipe <name>`. On start:
`hDesk = OpenDesktop(name, 0, false, GENERIC_ALL)` then
`SetThreadDesktop(hDesk)` **before creating any window, DC, or bitmap** — the desktop
association is per-thread and fixed at handle-creation time, so this ordering is not
optional. Then reuse the exact same `GdiCapture` and `InputInjector` from Phases 3–4
(this is why they were written as reusable classes). Stream frames and accept input
over a named pipe back to the applet.

### 5.5 IPC (`Shared/PipeChannel.cs`)
`NamedPipeServerStream` in the applet, client in the helper. Name it with a
per-session GUID. **Set an ACL allowing only LocalSystem and the current user**
(`PipeSecurity` with those two SIDs) — a world-writable pipe carrying input events
into a SYSTEM process is a local privilege-escalation hole. Length-prefixed frames,
same `[0x01]`/`[0x02]` payloads as the WS protocol so the applet can forward without
re-encoding.

### 5.6 Applet-side switching
On `desktopChanged`:
- Stop reading from the user-desktop capturer, start forwarding helper frames (or vice
  versa). Send `host.desktopChanged` so the console shows the "UAC prompt active"
  banner.
- Route incoming `agent.input` to the helper pipe while the secure desktop is active.
- Send a full keyframe immediately on switch — the desktop content changes completely.

### 5.7 Teardown
On session end: stop and delete the service (`ControlService(SERVICE_CONTROL_STOP)`,
`DeleteService`), kill helpers, delete `%ProgramData%\HelpdeskAnywhere\`. Verify with
`sc query HelpdeskAnywhereSvc` returning "does not exist". **Also handle the applet
being killed** — give the service a watchdog that self-uninstalls if the pipe stays
disconnected for 60s.

**Acceptance 🪟:** Run the whole set **twice** — once signed in as a local admin, once
as a standard user (see the test-account note in `CLAUDE.md`).

1. *Admin account, mode A:* agent picks "ask the user to approve"; user approves the
   native prompt; console shows "elevated".
2. *Standard-user account, mode B:* agent enters admin credentials in the console;
   **no prompt appears on the user's screen at all**; console shows "elevated". The
   session indicator shows the elevation notice.
3. Mode B with a wrong password → clear "logon failure" message, session survives
   unelevated, failure is audited, 6th attempt is rate-limited.
4. Agent right-clicks any .exe → "Run as administrator". **The UAC dialog is visible
   in the browser**, the banner appears, and the agent can click Yes/No and **type an
   admin password into it**.
5. After the prompt closes, the view returns to the normal desktop automatically.
6. `Ctrl+Alt+Del` button now works and the Secure Attention screen is visible.
7. Lock the machine (Win+L) — the logon screen is visible and the agent can type the
   password to log back in.
8. End session → `sc query` shows no service; `%ProgramData%\HelpdeskAnywhere` is gone;
   reboot leaves nothing behind.
9. **Grep the audit log and all server/browser logs for the test password — zero hits.**

If items 2 and 4 both work, the POC has proven its central claim: an agent can fully
resolve a UAC prompt on a locked-down machine without ever sharing the admin password
with the end user.

---

## Phase 6 — Remote script execution
**~2–3 days**

### 6.1 Applet side (`Scripting/ScriptRunner.cs`)
Handle `agent.exec`. Write the script to a temp `.ps1`/`.cmd`, run via
`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>` (or
`cmd /c`), with `RedirectStandardOutput/Error`, reading both streams **asynchronously
on separate tasks** (a single synchronous read deadlocks on large output). Stream
partial output back as it arrives rather than only on exit, so long-running scripts are
watchable. Enforce a configurable timeout (default 120s) and kill the whole process
tree on timeout or session end.

`asSystem: true` routes the request over the pipe to the elevated service, which runs
it as LocalSystem — reject with a clear error if not yet elevated.

### 6.2 Console side
A textarea + shell selector + "Run as SYSTEM" checkbox + Run button, and an output pane
that appends streamed chunks and shows the exit code. Keep a per-session history of
executed scripts.

### 6.3 Guardrails (do not skip — see constraint #5)
- Every execution is written to the audit log with full script text, requesting agent,
  timestamp, and exit code, **before** the process starts.
- The session indicator on the user's machine shows a transient "The agent ran a
  script" line. The user should never be unaware that code was executed on their box.
- Cap output at 1MB per execution to avoid memory blowups.

**Acceptance 🪟:** Run `Get-Process | Select -First 5` → correct output in the browser.
Run a script printing for 30s → output streams incrementally. Run something exceeding
the timeout → killed cleanly, error reported. Run with "as SYSTEM" → `whoami` returns
`nt authority\system`. All appear in the audit log.

---

## Phase 7 — Package, TLS, deploy, internet test
**~3–4 days**

### 7.1 Docker
`server/Dockerfile`: multi-stage `node:22-alpine` build → runtime, non-root user,
`HEALTHCHECK`. `docker-compose.yml` with two services:
- `caddy` — ports 80/443, volumes for certs + `server/public`, auto Let's Encrypt.
- `app` — the Node server on an internal port, `audit` volume mounted.

### 7.2 Public hostname — DuckDNS (do this before first Caddy start)
A free subdomain, so Caddy can get a real Let's Encrypt certificate. ~10 minutes.

1. Sign in at `https://www.duckdns.org` (GitHub/Google), create a subdomain, e.g.
   `helpdesk-anywhere`. Note the account token.
2. Set it to the VM's public IP:
   ```bash
   curl "https://www.duckdns.org/update?domains=<sub>&token=<token>&ip=<vm-public-ip>"
   ```
   Expect `OK`.
3. Keep it current (harmless if the IP is static, essential if not) — `crontab -e`:
   ```
   */5 * * * * curl -fsS "https://www.duckdns.org/update?domains=<sub>&token=<token>&ip=" >/dev/null
   ```
   Empty `ip=` makes DuckDNS use the caller's source IP.
4. Verify from **off the VM**: `dig +short <sub>.duckdns.org` returns the right IP.
   Do not start Caddy until this resolves publicly, or the ACME HTTP-01 challenge fails
   and Let's Encrypt rate-limits repeated failures.

Put the hostname in `.env` as `PUBLIC_HOST`; the portal builds join links from it.

### 7.3 Caddyfile
```
{$PUBLIC_HOST} {
    handle /download/* {
        root * /srv/public
        file_server
    }
    reverse_proxy app:8080
}
```
Caddy obtains and renews the certificate automatically and handles the WSS upgrade
through `reverse_proxy` with no extra config. Serve everything on **443 only** —
custom ports are exactly what corporate egress filtering blocks, which would sink the
"works from anywhere" demo.

### 7.4 Cloud host
Any Ubuntu 22.04/24.04 VM (Oracle Cloud Always-Free ARM works; build the image for the
right arch). Open **only 80 and 443** in the security group *and* in `ufw` — on Oracle
Cloud the instance-level iptables are a separate, commonly-missed layer, and 80 must be
open for the ACME challenge even though all real traffic is on 443.

### 7.5 Why not a bare IP, and why not S3
Both were considered and rejected — don't reintroduce them without reading this.

**Bare IP over plain HTTP** fails twice: Chrome blocks executable downloads served over
plain HTTP ("Insecure download blocked"), adding a third confusing click for the end
user; and the Phase 5 demo has them typing an **admin password into a UAC prompt**,
which would cross the public internet in cleartext along with every keystroke and
frame. Bare-IP HTTPS is possible since Let's Encrypt's IP-certificate GA in January
2026 (Certbot 5.3+ `--ip-address`), but only under the `shortlived` ~160-hour profile
with Certbot driving renewal instead of Caddy's auto-TLS — more moving parts, uglier
URL, no benefit over a free subdomain.

**S3 for the .exe** buys nothing once Caddy has TLS: one setup already covers both the
download and the session traffic, and `build-windows.sh` puts the binary exactly where
Caddy serves it. If it is added later (CDN, stateless VM), use **presigned URLs with a
short expiry generated per session** — never a public bucket. A permanently public,
unauthenticated, unsigned remote-control binary is directly useful to tech-support
scammers, with your AWS account and reputation attached.

### 7.6 The unsigned-binary reality
The downloaded .exe will trigger SmartScreen ("Windows protected your PC") and may be
quarantined by Defender. For the POC: document the "More info → Run anyway" click on
the join page and add the Defender exclusion on test machines. For anything beyond a
POC you need an **OV or EV code-signing certificate** — budget 1–3 weeks for
procurement/validation, and expect reputation with SmartScreen to build over weeks of
download volume even after signing. Do not treat AV detection as a bug to engineer
around; sign the binary instead.

### 7.7 Internet end-to-end test
Agent console on the Ubuntu box (or any browser). Windows machine on a **genuinely
different network** — a phone hotspot guarantees a different NAT and public IP, and a
friend in another location is the real test. Share only
`https://<sub>.duckdns.org/j/<code>`. Full flow: link → download → run → code →
consent → view → control → UAC unlock → UAC prompt → script → end.

Measure and record: time-to-connect, FPS, bandwidth, and latency on the hotspot. This
is the number people will ask about.

### 7.8 Quick pre-deploy alternative
Before touching cloud infra, prove the flow with `ngrok http 8080` against the local
dev server — a public HTTPS URL in ~2 minutes, no deployment. Do this at the end of
Phase 4; it de-risks Phase 7 by separating "does the architecture work over the
internet" from "is my Docker/Caddy/DNS config right".

**Acceptance:** Full flow completes over the public internet with the Windows machine
on a different network, using only the `https://<sub>.duckdns.org/j/<code>` URL.
Browser shows a valid padlock (no cert warning), the .exe downloads without an
"insecure download" prompt, and documented metrics are captured. Server survives
`docker compose down && up` with no manual steps and no cert re-issuance.

---

## Summary schedule

| Phase | Days | Risk |
|---|---|---|
| 0 — Environment | 0.5 | low |
| 1 — Server, pairing, portal | 2–3 | low |
| 2 — Applet connect + consent | 2 | low |
| 3 — Capture + streaming | 4–5 | medium |
| 4 — Input injection | 2–3 | medium |
| **5 — UAC / Secure Desktop (both elevation modes)** | **6–8** | **high** |
| 6 — Script execution | 2–3 | low |
| 7 — Deploy + internet test | 3–4 | medium |
| **Total** | **~22–29 working days (4.5–6 weeks)** | |

## Deliberately out of scope for this POC
Tracked here so scope creep is a decision, not an accident: authentication and the
agent portal login, multi-tenant/org model and RBAC, unattended (pre-installed) access,
macOS/Linux hosts, mobile viewers, file transfer, session recording, multi-monitor
switching UI (Phase 3 captures the full virtual desktop instead), TURN/STUN and direct
P2P, horizontal scaling of the relay, and a persistent database.

**The one to reconsider first:** the agent portal has *no authentication* — anyone who
reaches the URL can create a session. Once Phase 7 puts it on a public DuckDNS
hostname, that URL is reachable by the entire internet, including scanners that index
new Let's Encrypt certificates within minutes. Add `basic_auth` to the portal route in
the `Caddyfile` (one directive, `caddy hash-password` for the hash) as part of Phase 7 —
not later. The `/j/:code` join page and `/download/*` must stay unauthenticated, since
end users need them; only the agent console needs protecting.

## First actions for Claude Code
1. Confirm the Ubuntu prerequisites in Phase 0 and report versions.
2. Scaffold the tree, `.gitignore`, `git init`, initial commit.
3. Build Phase 1 end-to-end including `scripts/mock-host.js`, and demonstrate the
   Phase 1 acceptance test passing before writing any C#.
4. Then stop and confirm the Windows test machine is ready (VM up, admin rights,
   Defender exclusion set) before starting Phase 2.


