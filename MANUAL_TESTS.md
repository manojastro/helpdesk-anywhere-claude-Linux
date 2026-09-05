# Helpdesk Anywhere — Manual Tests

Windows code cross-compiles on Ubuntu but cannot execute here (`CLAUDE.md`, "Hard
environment boundary"). Everything that needs a real Windows desktop is recorded
here instead of blocking development.

**Nothing in this file may be marked PASSED by Claude.** Only the user, having run
the test on the Windows machine, can change a status to PASSED or FAILED.

| Test | Phase | Covers | Status |
|---|---|---|---|
| MT-01 | 2 | Connect, six-digit code, consent, indicator, disconnect | **FAILED 2026-09-05** — fix shipped, RETEST REQUIRED |
| MT-02 | 3 | GDI capture, streaming, cursor, multi-monitor, resize | PENDING |
| MT-03 | 4 | `SendInput` mouse and keyboard, drag, no stuck modifiers | PENDING |
| MT-04 | 6 | Real PowerShell, streamed output, timeout, tree kill | PENDING |
| MT-05 | 7 | External network, TLS, download, the whole flow | PENDING |
| MT-06 | 5 | UAC / Secure Desktop — **run twice**, admin then standard user | **FAILED 2026-09-05 (mode A)** — fix shipped, RETEST REQUIRED |

**Run MT-05 first**: every other test needs a reachable HTTPS endpoint, and two
of them (the `.exe` download, credential-mode elevation) cannot work without one.

---

## MT-01 — Phase 2 applet: connect, code entry, consent

**Status:** FAILED (2026-09-05, first real Windows run) — **RETEST REQUIRED**
**Related Phase:** 2
**Related Commit:** Phase 2 commit on `main`; the startup fix is the
`fix(windows)` / `test(windows)` pair of 2026-09-05 (see `git log`)

> **Retest with the replacement binary, not the one already on the machine.**
> The first attempt failed before the application UI existed. Delete the old
> `HelpdeskAnywhere.exe`, download the replacement, and confirm the hash before
> running it — the two are indistinguishable by name, size band or icon.
>
> | | |
> |---|---|
> | SHA-256 | `02cfab185ec479b3359bf8b90ccbed6d2eb10ee6d2a1edfa8e51ed38e9ee0c79` |
> | Size | 65,913,220 bytes |
> | URL | `https://sarah-wanted-councils-lewis.trycloudflare.com/download/HelpdeskAnywhere.exe` |
>
> (Superseded twice since the MT-01 fix — by MT-06's secure-desktop fix and then
> by the move off ngrok. There is only ever one `.exe`, and it carries both fixes.)
>
> ```powershell
> Get-FileHash .\HelpdeskAnywhere.exe -Algorithm SHA256
> ```
>
> Step 0 of the run below is now: **the window appears at all.** If it does, the
> side-by-side defect is fixed and steps 1-8 are the real test.

### Preconditions

- Windows 10 22H2 or Windows 11 x64 — throwaway VM or spare laptop.
- Microsoft Defender path exclusion for the applet's download folder.
- The server must be reachable from the Windows machine **over HTTPS**: Chrome
  blocks executable downloads served over plain HTTP. Fastest route (`PLAN.md` 7.8
  brought forward):

  ```bash
  ./scripts/dev-server.sh                       # terminal 1 → :8080
  ngrok http 8080                               # terminal 2 → https://xxxx.ngrok-free.app
  SERVER_URL="wss://xxxx.ngrok-free.app/ws" ./scripts/build-windows.sh   # terminal 3
  ```

  Alternative without a tunnel: type `ws://<server-ip>:8080/ws` into the applet's
  "Server address" field and transfer the .exe to the VM by other means. That skips
  the download-page half of the test.

### Steps

1. On any browser, open the agent console at `https://<host>/` and click to create a
   session. Note the 6-digit code and the join link.
2. On the Windows machine, open `https://<host>/j/<code>`.
3. Download the helper. Expect SmartScreen — "More info" → "Run anyway". That
   detection is correct behaviour for an unsigned binary, not a bug.
4. Run the .exe. Type the 6-digit code. Click Connect.
5. At the consent dialog, click **Decline**. (First pass.)
6. Repeat steps 4–5, this time clicking **Accept**.
7. Click **End Session** on the red indicator.
8. Repeat once more, and this time end the session from the **agent console** side.

### Expected Result

- Code entry accepts only digits; a wrong code shows a clear error and lets the user
  retype without restarting the applet.
- The consent dialog names the requesting agent ("Support Agent" by default), is
  topmost and centred, and cannot be dismissed with Esc.
- **Decline** → the console shows "declined", the applet exits, nothing streamed.
- **Accept** → the console flips to connected; a red always-on-top indicator appears
  bottom-right reading "Screen is being shared with <agent>" with an End Session
  button. It cannot be minimised away and returns to the top if another window
  covers it.
- **End Session** (either side) → both ends tear down; the applet process exits with
  no leftover process, service, or temp files.
- `audit/*.jsonl` records session created / joined / consent / ended.

### Actual Result

**2026-09-05 — attempt 1: FAILED.** The applet never started. Windows showed:

> The application has failed to start because its side-by-side configuration is
> incorrect. Please see the application event log or use the command-line
> sxstrace.exe tool for more detail.

`sxstrace` reported, against `C:\AI\HelpdeskAnywhere.exe`:

```
INFO: Parsing Manifest File C:\AI\HelpdeskAnywhere.exe.
  INFO: Manifest Definition Identity is (null).
ERROR: Line 2: XML Syntax error.
ERROR: Activation Context generation failed.
```

No step of the test was reached: this is the loader refusing the process, before
`Main`, so nothing about code entry, consent or the indicator was exercised.

**Root cause (proven from the build artifacts, not inferred from the message).**
`windows/Applet/app.manifest` contained `--install-service` inside an XML comment.
XML 1.0 section 2.5 forbids `--` inside a comment, so the manifest was not
well-formed. The RT_MANIFEST resource extracted from the shipped 65,901,261-byte
`.exe` was byte-identical to that source file, and `expat` rejects it at line 7,
column 32. MSBuild's `<ApplicationManifest>` never parses the file — it copies the
bytes into the PE resource — so the defect cross-compiled cleanly on Ubuntu and
passed every Linux test. `sxstrace` says line 2 where `expat` says line 7 because
Microsoft's parser counts from the first element; the failing construct is the
same one. Full write-up in `CHANGELOG.md` and `DEV_NOTES.md`.

**Fix and status.** Comment reworded; a strict manifest validator now runs in the
`source` test block and gates `scripts/build-windows.sh`, checking the resource
inside the built `.exe` and not just the source. Replacement binary rebuilt clean
against the live endpoint (hash above). **FIX IMPLEMENTED · BUILD VERIFIED ·
AUTOMATED TEST VERIFIED · WINDOWS RETEST REQUIRED.**

**2026-09-05 - attempt 2, mode A: FAILED differently.** The secure-desktop watcher
now runs in the interactive session and detected `Default -> Winlogon` correctly,
but the DesktopHelper it launched exited ~300ms after each launch and was relaunched
in a tight loop (on Default too, before UAC). The watcher logged `exitCode=?` and no
`[helper]` lines reached the applet log, so the failing stage was not readable.

Fixes shipped (see CHANGELOG / DEV_NOTES): the watcher now logs the helper's REAL
exit code and lifetime; the helper logs `HELPER ENTRY REACHED` and its args before
anything can fail and traps startup exceptions; a crash-loop ceiling stops the
runaway respawn; and no redundant helper is launched on the applet's own Default
desktop. These make the next run self-diagnosing and stop the damage. **FIX
IMPLEMENTED (diagnostics + safety + design) · BUILD VERIFIED · AUTOMATED TEST
VERIFIED · WINDOWS RETEST REQUIRED.** Replacement EXE sha256 `02cfab185ec479b3359bf8b90ccbed6d2eb10ee6d2a1edfa8e51ed38e9ee0c79`.

**2026-09-05 - attempt 3, mode A: FAILED, and it named its own cause.** The watcher
detected `Default -> Winlogon`, launched the helper on `WinSta0\Winlogon` in
session 5, and five helpers each exited in ~320-336ms with **exitCode=3** - the
helper's stage code for SetThreadDesktop. The bounded-restart ceiling added in
attempt 2 stopped the loop correctly.

Root cause: the helper is already on the target desktop (the watcher passes
`STARTUPINFO.lpDesktop = WinSta0\Winlogon`, which binds the process at creation),
and `SetThreadDesktop` cannot succeed on a thread that owns a window - `Main` is
`[STAThread]`, so OLE's hidden message window exists before `Main` runs. The call
was both redundant and guaranteed to fail. Fixed: skip it when already bound,
switch only when genuinely needed, and verify the bound desktop before capturing.
**FIX IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED · WINDOWS RETEST
REQUIRED.** Replacement EXE sha256 `02cfab185ec479b3359bf8b90ccbed6d2eb10ee6d2a1edfa8e51ed38e9ee0c79`.

_(attempt 4 - to be filled in by the user)_

---

## MT-02 — Phase 3: screen capture and streaming

**Status:** PENDING
**Related Phase:** 3
**Related Commit:** Phase 3 capture/streaming commit on `main` (see `git log`)

### Preconditions

- MT-01's setup, and ideally MT-01 itself passing first.
- Test at least once on a **multi-monitor** configuration, and once after changing
  the display resolution mid-session.

### Steps

1. Complete a session through consent (MT-01 steps 1–6).
2. Watch the agent console's canvas.
3. Move a window around on the Windows machine; type into Notepad.
4. Read the FPS / kbps counter under the canvas on a mostly-static desktop, then
   while dragging a window.
5. Change the Windows display resolution while the session is live.
6. If the VM has two displays, confirm both appear side by side in one image.
7. End the session.

### Expected Result

- The live desktop renders in the browser at **>= 8 FPS**, text legible.
- The **mouse cursor is visible** — `BitBlt` does not capture it, so it is
  composited manually; if the cursor is missing, `DrawCursor` is the suspect.
- Moving a window updates smoothly; a mostly-static desktop drops to a low kbps
  (dirty rects working) and rises while dragging.
- A resolution change re-sizes the canvas and repaints it fully within ~5 s.
- On multi-monitor, the whole virtual desktop appears, correctly laid out, with no
  black band and no offset (that would mean the virtual-screen origin is wrong).
- Ending the session stops the stream immediately; no capture thread or GDI handle
  leak survives (check Task Manager: the applet process is gone).

### Actual Result

_(to be filled in by the user)_

---

## MT-03 — Phase 4: remote mouse and keyboard

**Status:** PENDING
**Related Phase:** 4
**Related Commit:** Phase 4 input commit on `main` (see `git log`)

### Preconditions

MT-02's setup. Test on a multi-monitor VM if one is available — the absolute
coordinate normalisation is exactly what multi-monitor breaks.

### Steps

1. Establish a session and confirm the desktop is visible (MT-02).
2. Click the canvas to focus it, then move the mouse to each of the **four screen
   corners** and confirm the remote cursor arrives at the same corner.
3. On a second monitor, repeat at its far corner.
4. Left-click, right-click (a context menu must appear on the remote, not in the
   agent's browser), and middle-click.
5. Drag a window across the screen and drop it.
6. Scroll a long document up and down.
7. Open Notepad and type: lowercase, uppercase (Shift), digits, symbols
   (`!@#$%^&*()_+-={}[]|\:;"'<>,.?/`), Backspace, Delete, arrows, Home/End, Tab.
8. Press the **Alt+Tab** button in the console, then **Win**, then **PrtScn**.
9. While dragging (mouse held down) and while holding Ctrl, **pull the network cable
   / kill the session from the console**.

### Expected Result

- The cursor lands exactly where the agent points, at every corner and on every
  monitor. An offset that grows toward the bottom-right means the CSS size is being
  used instead of the backing store; a wrong monitor means the virtual-desktop
  normalisation is wrong.
- All three buttons work; right-click opens the remote context menu and **not** the
  browser's.
- Drag and scroll behave normally.
- Everything typed appears correctly, including symbols. Wrong characters for
  symbols usually means `event.key` leaked in where `event.code` was intended.
- Alt+Tab switches windows on the remote machine; Win opens the Start menu.
- **After the abrupt disconnect: no stuck modifier and no stuck mouse button.**
  Verify by typing in a local app on the Windows machine — if every letter comes out
  as a shortcut, Ctrl is stuck and `ReleaseAll` did not run.
- Ctrl+Alt+Del remains disabled and is not expected to work until Phase 5.

### Actual Result

_(to be filled in by the user)_

---

## MT-04 — Phase 6: remote script execution

**Status:** PENDING
**Related Phase:** 6
**Related Commit:** Phase 6 commit on `main` (see `git log`)

### Preconditions

MT-01's setup and a live consented session.

### Steps

1. Run `Get-Process | Select -First 5` in PowerShell mode.
2. Run a script that prints for ~30 s, e.g.
   `1..30 | ForEach-Object { $_; Start-Sleep -Seconds 1 }`.
3. Run something that never finishes, e.g. `while ($true) { Start-Sleep 1 }`, and
   wait past the 120 s timeout.
4. Run `dir` with the shell set to **cmd**.
5. Tick **Run as SYSTEM** and run `whoami`.
6. Run a script producing more than 1 MB, e.g. `1..200000 | ForEach-Object { "x" * 40 }`.
7. Watch the user's session indicator while each script runs.
8. End the session while a long script is still running.
9. Inspect `audit/audit-<date>.jsonl` afterwards.

### Expected Result

- (1) Correct process list in the browser, exit code 0.
- (2) Output appears **incrementally**, roughly every 250 ms — not all at once at the
  end. This is the whole point of the `partial` flag.
- (3) Killed at ~120 s, `[killed: exceeded the 120s timeout]` shown, exit code -1, and
  **no orphaned powershell.exe** left in Task Manager.
- (4) cmd works as well as PowerShell.
- (5) Until Phase 5 lands, this must be **refused** with "Run as SYSTEM requires
  elevation…" — it must never silently run as the ordinary user instead.
- (6) Output stops at ~1 MB with `[output truncated at 1024 KB]`; the console stays
  responsive.
- (7) The indicator shows "The agent ran a script on this computer." — the user is
  never unaware that code was executed (constraint #5).
- (8) The running process is killed and the temp folder under
  `%TEMP%\HelpdeskAnywhere\` is gone.
- (9) Every run appears as `exec.requested` **with the full script text, before** its
  `exec.result`, and there is exactly one `exec.result` per run despite the streaming.

### Actual Result

_(to be filled in by the user)_

---

## MT-05 — Phase 7: external access end to end

**Status:** PENDING
**Related Phase:** 7
**Related Commit:** Phase 7 commit on `main` (see `git log`)

This is the test that turns MT-01…MT-04 from local exercises into the real
product flow, and it is the one to run first — the others all need it.

### Preconditions

- An ngrok account (free) and its authtoken in `.env` as `NGROK_AUTHTOKEN`.
- `CONSOLE_PASSWORD` set in `.env` to something real.
- Windows test machine as described in `CLAUDE.md`, ideally on a **different
  network** (a phone hotspot guarantees a different NAT and public IP).

**As of 2026-09-04 the deployment is already up and verified 16/16**, so step 1
can be skipped unless the tunnel has since been restarted:

```
console   https://paternity-cannot-removal.ngrok-free.dev/
join      https://paternity-cannot-removal.ngrok-free.dev/j/<code>
download  https://paternity-cannot-removal.ngrok-free.dev/download/HelpdeskAnywhere.exe
```

No ngrok domain is reserved, so **that URL dies with the tunnel.** After any
restart, re-read the new one from `deploy-ngrok.sh`'s output and re-bake the
applet — the `.exe` on the download page dials the URL it was built with.

### Steps

1. On the Ubuntu box: `./scripts/deploy-ngrok.sh` — or, if the tunnel above is
   still up, `curl -sS <console URL>healthz` and check `publicHost` matches it.
2. Confirm the deployment verification block at the end reports 16 passed.
3. Open the printed console URL in a browser. Expect a password prompt; sign in
   as `agent` with `CONSOLE_PASSWORD`.
4. Create a session and note the six-digit code and join link.
5. On the Windows machine, open the join link. (Free ngrok shows an interstitial
   page on first visit — click through it.)
6. Download the helper. Confirm Chrome does **not** block the download.
7. SmartScreen → More info → Run anyway. Type the code. Accept the consent prompt.
8. Work through MT-01, MT-02, MT-03, MT-04 and then MT-06 over this connection.
9. Back on the Ubuntu box: `./scripts/verify-audit.sh`

### Expected Result

- The console demands the password before showing anything.
- `/healthz` reports the tunnel hostname as `publicHost`, not `localhost:8080`.
  If it says `localhost`, the applet was very likely baked to dial
  `wss://localhost:8080/ws` and will never connect from the Windows machine.
- Opening the console URL in a private window without credentials gets a 401, and
  a WebSocket client that has not authenticated cannot create a session code.
- The join page and the download work **without** credentials.
- The `.exe` downloads over HTTPS with no "insecure download" block.
- The full session works from a different network with no firewall changes on
  either machine.
- `verify-audit.sh` passes, showing session/consent/exec records and **no**
  credential-shaped field anywhere.

### Actual Result

_(to be filled in by the user)_

---

## MT-06 — Phase 5: UAC / Secure Desktop, both elevation modes

**Status:** FAILED (2026-09-05, mode A, first real Windows run) — **RETEST REQUIRED**
**Related Phase:** 5
**Related Commit:** Phase 5 commit on `main`; the secure-desktop fix is the
`fix(windows)` / `test(windows)` pair of 2026-09-05 (see `git log`)

> ### First attempt: FAILED at step 7
>
> Mode A elevation itself worked. The genuine UAC prompt for
> `HelpdeskAnywhere.exe` appeared, the user clicked Yes, the desktop returned. A
> later UAC prompt (TeamViewer) appeared correctly on the Windows machine — and
> **the technician canvas turned BLACK**, not frozen, recovering when the prompt
> closed.
>
> **Root cause.** `DesktopWatcher` polled `OpenInputDesktop` from the LocalSystem
> service, in session 0. That call is scoped to the calling process's window
> station, and window stations are per-session: a session-0 service is on
> `Service-0x0-3e7$`, which has no input desktop. The `Default → Winlogon` switch
> was structurally invisible from there, so no helper ever reached the Secure
> Desktop and the applet was never told to stop capturing. A `BitBlt` of a desktop
> that no longer owns the display succeeds and returns **black**, so the applet
> sent black keyframes and every layer above treated them as a working stream.
>
> **Fix.** The watch moved into the interactive session as its own process
> (`--desktop-watch`; `DECISIONS.md` D-010), the applet now detects the Secure
> Desktop itself and suppresses frames rather than sending black ones, the handoff
> between capturers became an explicit state machine, and elevation is reported
> only once the SYSTEM half is actually usable. Full write-up in `CHANGELOG.md`
> and `DEV_NOTES.md`.
>
> ### Retest with the replacement binary
>
> | | |
> |---|---|
> | SHA-256 | `02cfab185ec479b3359bf8b90ccbed6d2eb10ee6d2a1edfa8e51ed38e9ee0c79` |
> | Size | 65,913,220 bytes |
> | Download | `https://sarah-wanted-councils-lewis.trycloudflare.com/download/HelpdeskAnywhere.exe` |
>
> ```powershell
> Get-FileHash .\HelpdeskAnywhere.exe -Algorithm SHA256
> ```
>
> **Run the diagnostic script alongside the test.** MT-06 spans four processes and
> two Windows sessions, and the helper exists only while a UAC prompt is up — a
> snapshot taken afterwards always says "helper missing". From an elevated
> PowerShell, start it and then trigger the prompt:
>
> Download it from the same place as the applet:
>
> | | |
> |---|---|
> | URL | `https://sarah-wanted-councils-lewis.trycloudflare.com/download/mt06-diagnostics.ps1` |
> | SHA-256 | `4e66d32e243c31b2ecea42995aab62ff850e20f6b746efdb2fcde92267891db5` |
>
> ```powershell
> powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HOME\Downloads\mt06-diagnostics.ps1" -Watch 40
> ```
>
> It prints a stage-by-stage verdict across the whole chain and points at the
> unified log (`%LOCALAPPDATA%\HelpdeskAnywhere\logs\`). **Attach that log to the
> result** — it is what makes one retest enough.
>
> (The first version of this script would not parse on Windows PowerShell 5.1:
> six UTF-8 em dashes in a file with no byte-order mark, which 5.1 decodes with
> the system ANSI code page. Fixed, and now validated by the regression suite.)
>
> ### Transport — moved off ngrok, and the hostname is volatile
>
> ngrok hit its monthly bandwidth cap on 2026-09-05 (`ERR_NGROK_725`) and blocked
> the retest entirely. The deployment now runs behind a **Cloudflare quick
> tunnel** (`DECISIONS.md` D-011): no account, no token, no cap, verified 16/16.
>
> **The hostname is random and changes every time the tunnel restarts**, and the
> applet has it baked in. If the applet starts but never connects, that is the
> first thing to check: re-run `./scripts/deploy-cloudflared.sh` on the Ubuntu box,
> then re-download — the SHA-256 above will have changed with it.

This is the feature the whole POC exists to prove, and the only one where a
successful compile says almost nothing. **Run the whole test twice** — once signed
in as a local administrator (mode A) and once as a standard user (mode B) — per
`PLAN.md` Phase 5 "Acceptance" and the two-account requirement in `CLAUDE.md`.

### Preconditions

- MT-05 passing, so there is a reachable HTTPS endpoint. **Credential mode is
  hard-refused over a non-`wss:` connection** and cannot be tested locally over
  plain HTTP — that refusal is deliberate (constraint #6.1).
- Both accounts from `CLAUDE.md` → "Windows test machine requirements": a local
  administrator, and a standard user plus separate admin credentials.

  **Create them yourself, on the test VM, at test time.** No credential for this
  test exists in this repository and none may be added to it. From an elevated
  PowerShell, choosing your own throwaway password when prompted:

  ```powershell
  # the admin account whose credentials the agent will type into the console
  New-LocalUser -Name "hda-admin" -Description "throwaway, delete after MT-06"
  Add-LocalGroupMember -Group "Administrators" -Member "hda-admin"

  # the standard user who will be sitting at the machine for mode B
  New-LocalUser -Name "hda-user" -Description "throwaway, delete after MT-06"
  ```

  Use a password you are willing to see in a grep command, and **delete both
  accounts when the test is done** (`Remove-LocalUser`).
- Step 22 greps every log on both machines for that password.
- Defender path exclusion for the applet's folder. Expect SmartScreen on an
  unsigned binary; that detection is correct behaviour, not a bug.
- Before starting: `sc query HelpdeskAnywhereSvc` → "does not exist", and
  `%ProgramData%\HelpdeskAnywhere\` absent.

### Steps — mode A (signed in as a LOCAL ADMINISTRATOR)

1. Start a session and consent as usual.
2. In the console's "Unlock UAC prompts" panel, leave the mode on
   *"User is an administrator — ask them to approve"* and click **Elevate**.
3. The console should say *"Ask the user to approve the Windows prompt on their
   screen."* Look at the Windows machine: a native UAC **consent** prompt (Yes/No,
   no password box).
4. Click **No** first. The console should report that the user declined, and the
   session should stay connected and unelevated.
5. Click **Elevate** again, then **Yes** on the Windows machine.
6. On the user's machine, check the session indicator: it must say the agent is
   elevating privileges, and then that the agent has administrator access.
7. Open something that triggers UAC — `Win+R`, `cmd`, Ctrl+Shift+Enter, or right-click
   Notepad → Run as administrator. **The agent's canvas must show the UAC prompt**,
   and the console must show its "UAC prompt active" banner.
8. Move the mouse and click **Yes** *from the console*. It must land on the prompt.
9. Type into a UAC credential prompt from the console (open one with `runas`).
10. Click **Ctrl+Alt+Del** in the console. The Windows security screen must appear.
11. In the script pane, tick **Run as SYSTEM**, run `whoami`, and confirm the output
    is `nt authority\system`. Then run something slow —
    `1..10 | ForEach-Object { $_; Start-Sleep -Seconds 1 }` — and confirm the
    output **appears as it is produced**, not all at once at the end: SYSTEM
    scripts stream partial results exactly as unelevated ones do.

### Steps — mode B (signed in as a STANDARD USER) ⭐

This is the one that matters on a managed fleet; without it the tool deadlocks.

12. Repeat steps 1–2, but select *"Enter admin credentials"* and type the admin
    account's domain (blank for a local account), username and password into the
    **console**.
13. Click **Elevate**.
14. **Watch the user's screen throughout: no prompt of any kind may appear on it.**
    That is the entire point of mode B — the agent never reveals the admin password
    to the end user, and the end user clicks nothing.
15. The console must report elevated; the user's session indicator must still show
    the elevation notice (they consented to being helped, not to silent privilege
    escalation).
16. Repeat steps 7–11 from this account.
17. Deliberately get it wrong, once each, and read the console message:
    - wrong password → must read as a bad username/password
    - an account that cannot log on interactively → must say so, not "wrong password"
    - a disabled or locked-out account → must say which
18. Attempt elevation six times in one session. The sixth must be refused by the
    **server** with `elevation_rate_limited`.

### Steps — teardown (run after BOTH modes)

19. End the session from the console. Within a few seconds — the applet asks the
    service to remove itself over the pipe, rather than waiting for the watchdog —
    on the Windows machine:
    - `sc query HelpdeskAnywhereSvc` → **"does not exist"**
    - `%ProgramData%\HelpdeskAnywhere\` → **gone**
    - no `DesktopHelper` / `HelpdeskAnywhere` process left in Task Manager
20. Repeat, but this time **kill the applet from Task Manager** instead of ending
    the session. Within ~60 seconds the service's watchdog must remove the service
    and the directory by itself. Re-check both.
21. Reboot the machine and confirm nothing comes back and nothing is left behind.

### Steps — credentials must not be anywhere (constraint #6)

22. On the Ubuntu box, with `<PASSWORD>` being the throwaway admin password:
    ```bash
    grep -ri '<PASSWORD>' audit/ ; docker compose logs app | grep -i '<PASSWORD>'
    ./scripts/verify-audit.sh
    ```
    Both greps must find **nothing**. The audit log must contain
    `elevation.requested` records carrying the mode, domain, username and outcome —
    and no password field.
23. On the Windows machine, confirm no file under `%ProgramData%\HelpdeskAnywhere\`
    or `%TEMP%` contains the password (it should all be gone by now anyway).

### Expected Result

- Mode A: native consent prompt on the user's screen; decline is survivable;
  approve elevates.
- Mode B: **no prompt on the user's screen at all**; the console elevates from
  typed credentials.
- Both: UAC prompts are visible and clickable from the console, Ctrl+Alt+Del works,
  `whoami` as SYSTEM returns `nt authority\system`, and the user's indicator shows
  the elevation.
- Error messages name the actual problem, not a number.
- After the session — by either exit path — the service does not exist, the
  directory is gone, and nothing survives a reboot.
- The admin password appears in no log, on either machine.

### Actual Result

**2026-09-05 — attempt 1, mode A: FAILED at step 7.**

Steps 1-6 passed. Elevation mode A worked end to end: the console offered
*"User is an administrator — ask them to approve"*, Elevate produced the genuine
Windows UAC consent prompt for `HelpdeskAnywhere.exe` on the endpoint, the user
clicked **Yes**, and the normal desktop returned.

Step 7 failed. A later genuine UAC prompt (TeamViewer) was raised. The Windows
machine displayed it correctly on the Secure Desktop — "User Account Control /
TeamViewer / Yes / No". **The Helpdesk Anywhere technician canvas did not show it.
The canvas went BLACK**, and recovered when the prompt closed.

Black rather than frozen is the diagnostic detail: frames were still arriving, and
they were black ones.

Steps 8-11 (remote click, remote typing, Ctrl+Alt+Del, `whoami` as SYSTEM) were not
reached, because there was nothing on the canvas to click.

**Root cause, from the source and Windows' documented behaviour.** The desktop
watch ran in the wrong session. `DesktopWatcher` polled `OpenInputDesktop` inside
the LocalSystem service, which is in session 0; that call resolves the input desktop
of the calling process's window station, and window stations are per-session. A
session-0 service is on `Service-0x0-3e7$`, which has no input desktop at all — so
the `Default → Winlogon` switch could never be seen from there, no helper was ever
launched onto the Secure Desktop, and `AppletContext.OnDesktopChanged` never fired.
The applet's own capture therefore kept running against a desktop that no longer
owned the display, and a `BitBlt` in that state **succeeds and returns black**.

**Failure stage: desktop detection.** Helper launch and frame routing failed as a
consequence, not independently.

**Fix and status.** The watch moved into the interactive session as its own process
mode (`--desktop-watch`, `DECISIONS.md` D-010); the applet now detects a secure
desktop itself and suppresses frames instead of sending black ones; the handoff
between the two capturers is an explicit four-state machine; elevation is reported
only once the service is running, attached, and its watcher has started. A
four-process diagnostic log and `scripts/mt06-diagnostics.ps1` were added so the
retest produces evidence either way. **FIX IMPLEMENTED · BUILD VERIFIED · AUTOMATED
TEST VERIFIED · WINDOWS RETEST REQUIRED.**

Mode B (standard user, credential elevation) was **not reached** on this attempt.

**2026-09-05 - attempt 2, mode A: FAILED differently.** The secure-desktop watcher
now runs in the interactive session and detected `Default -> Winlogon` correctly,
but the DesktopHelper it launched exited ~300ms after each launch and was relaunched
in a tight loop (on Default too, before UAC). The watcher logged `exitCode=?` and no
`[helper]` lines reached the applet log, so the failing stage was not readable.

Fixes shipped (see CHANGELOG / DEV_NOTES): the watcher now logs the helper's REAL
exit code and lifetime; the helper logs `HELPER ENTRY REACHED` and its args before
anything can fail and traps startup exceptions; a crash-loop ceiling stops the
runaway respawn; and no redundant helper is launched on the applet's own Default
desktop. These make the next run self-diagnosing and stop the damage. **FIX
IMPLEMENTED (diagnostics + safety + design) · BUILD VERIFIED · AUTOMATED TEST
VERIFIED · WINDOWS RETEST REQUIRED.** Replacement EXE sha256 `02cfab185ec479b3359bf8b90ccbed6d2eb10ee6d2a1edfa8e51ed38e9ee0c79`.

**2026-09-05 - attempt 3, mode A: FAILED, and it named its own cause.** The watcher
detected `Default -> Winlogon`, launched the helper on `WinSta0\Winlogon` in
session 5, and five helpers each exited in ~320-336ms with **exitCode=3** - the
helper's stage code for SetThreadDesktop. The bounded-restart ceiling added in
attempt 2 stopped the loop correctly.

Root cause: the helper is already on the target desktop (the watcher passes
`STARTUPINFO.lpDesktop = WinSta0\Winlogon`, which binds the process at creation),
and `SetThreadDesktop` cannot succeed on a thread that owns a window - `Main` is
`[STAThread]`, so OLE's hidden message window exists before `Main` runs. The call
was both redundant and guaranteed to fail. Fixed: skip it when already bound,
switch only when genuinely needed, and verify the bound desktop before capturing.
**FIX IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED · WINDOWS RETEST
REQUIRED.** Replacement EXE sha256 `02cfab185ec479b3359bf8b90ccbed6d2eb10ee6d2a1edfa8e51ed38e9ee0c79`.

_(attempt 4 - to be filled in by the user)_

### Notes for whoever runs this

Two failures are worth recognising on sight (`DEV_NOTES.md` → Phase 5):

- Nothing appears on the canvas when a UAC prompt is up, but the banner shows:
  the helper started but is bound to the wrong desktop. Check that `lpDesktop`
  carries the window-station prefix — `WinSta0\Winlogon`, never bare `Winlogon`.
- The service starts and immediately stops, or the helper never appears: the
  token dance failed. `CreateProcessAsUser` returning 5 means the wrong token was
  duplicated, or `SetTokenInformation(TokenSessionId)` was skipped.
