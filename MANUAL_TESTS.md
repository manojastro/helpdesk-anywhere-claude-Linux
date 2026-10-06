# Helpdesk Anywhere — Manual Tests

Windows code cross-compiles on Ubuntu but cannot execute here (`CLAUDE.md`, "Hard
environment boundary"). Everything that needs a real Windows desktop is recorded
here instead of blocking development.

**Nothing in this file may be marked PASSED by Claude.** Only the user, having run
the test on the Windows machine, can change a status to PASSED or FAILED.

| Test | Phase | Covers | Status |
|---|---|---|---|
| MT-01 | 2 | Connect, six-digit code, consent, indicator, disconnect | **PASSED 2026-09-06** (real Windows) |
| MT-02 | 3 | GDI capture, streaming, cursor, multi-monitor, resize | **PASSED 2026-09-06** (real Windows; single monitor) |
| MT-03 | 4 | `SendInput` mouse and keyboard, drag, no stuck modifiers | **PASSED 2026-09-06** (real Windows) |
| MT-04 | 6 | Real PowerShell, streamed output, timeout, tree kill | PENDING — **needs real Windows; never run** |
| MT-05 | 7 | External network, TLS, download, the whole flow | PENDING (substantially exercised by every run) |
| MT-06 | 5 | UAC / Secure Desktop — **run twice**, admin then standard user | **mode A PASSED 2026-09-06** (real Windows) · mode B PENDING — **needs real Windows (standard user + admin credentials); never run** |
| MT-07 | FB1 | Fullscreen, zoom, magnifier, hold/resume against a real desktop | PENDING — **needs real Windows** |
| MT-08 | FB2 | Chat, Send URL, predefined replies, history & notes against a real desktop | PENDING — **needs real Windows** |
| MT-09 | Admin portal | Entra sign-in, verified name in the consent dialog, "chat is saved" notice, End Session recorded, UAC flow unchanged | PENDING — **needs real Windows + real Entra tenant** |
| MT-10 | Admin portal | Staging web walkthrough (no Windows, no Entra): portals, activation, session, chat incl. Tamil, PDF, suspension | PENDING — human walkthrough; the same flow passed automated on staging 2026-09-27 |
| MT-13 | Platform 2.0 P1 | Dashboard, PIN card, header, connection health, lifecycle phase; **golden UAC regression checklist** | PENDING — **needs real Windows** |
| MT-14 | Platform 2.0 P2 | Saved scripts on real PowerShell/cmd, SYSTEM script after elevation, activity, screenshot, chat system lines | PENDING — **needs real Windows** (also covers much of MT-04) |
| MT-15 | Platform 2.0 P2b | **New applet build**: file manager, upload/download, clipboard, system details, Stop — and the **full golden UAC regression** | PENDING — **needs real Windows + a server running this branch** |
| MT-16 | Platform 2.0 P3 | Customer network drop and recovery (same build as MT-15) | PENDING — **needs real Windows** |

**Run MT-05 first**: every other test needs a reachable HTTPS endpoint, and two
of them (the `.exe` download, credential-mode elevation) cannot work without one.

---

## MT-01 — Phase 2 applet: connect, code entry, consent

**Status:** **PASSED — 2026-09-06, real Windows manual acceptance**
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
> | SHA-256 | `5ff9764663e2016b91fc46ea036939ea8c842af049bc53b8f246536d02a48a40` |
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
VERIFIED · WINDOWS RETEST REQUIRED.** Replacement EXE sha256 `5ff9764663e2016b91fc46ea036939ea8c842af049bc53b8f246536d02a48a40`.

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
REQUIRED.** Replacement EXE sha256 `5ff9764663e2016b91fc46ea036939ea8c842af049bc53b8f246536d02a48a40`.

**2026-09-06 - attempt 4, mode A: SECURE DESKTOP PASSES; post-UAC elevated input failed.**

Confirmed working on real Windows, by the user:
- genuine Windows UAC Secure Desktop is VISIBLE in the technician canvas;
- the remote mouse reaches the Secure Desktop;
- remotely clicking **Yes** is accepted by Windows;
- UAC closes and the normal desktop stream returns.

Failed next: the application UAC launched (installer / "Run as administrator")
showed its normal UI on `WinSta0\Default`, and remote clicks and keystrokes did
not reach it. Root cause: **Windows UIPI** discards synthetic input sent from a
lower integrity level than the receiving window. The applet is Medium integrity by
design (`asInvoker`, `uiAccess=false`; it must never self-elevate); the post-UAC
target is High.

Fixed by giving the Default desktop an `--input-only` SYSTEM helper - above both
Medium and High - so its `SendInput` is accepted by ordinary and elevated windows
alike, with exactly one injector per event and no second capturer. UIPI itself is
untouched. **WINDOWS RETEST REQUIRED** for the elevated-application control.
Replacement EXE sha256 `5ff9764663e2016b91fc46ea036939ea8c842af049bc53b8f246536d02a48a40`.

**2026-09-06 - attempt 5, mode A: PASSED.** Confirmed by the project owner on the
real Windows test machine:

- genuine Windows UAC Secure Desktop VISIBLE in the technician console;
- remote mouse works on the Secure Desktop;
- remotely clicking **Yes** on the genuine UAC prompt is accepted by Windows;
- UAC completes and `Winlogon -> Default` returns to normal streaming;
- **the post-UAC elevated application accepts remote input** - buttons and menus,
  including an elevated installer's Next / Back / Install / Finish.

This is the flow the whole POC exists to prove, and it is the golden checkpoint
recorded in `GOLDEN_WORKING_STATE.md`.

Mode B (standard user + separate admin credentials) has still never been run.

---

## MT-02 — Phase 3: screen capture and streaming

**Status:** **PASSED — 2026-09-06, real Windows manual acceptance**
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

**Status:** **PASSED — 2026-09-06, real Windows manual acceptance**
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

**Status:** **mode A PASSED — 2026-09-06, real Windows manual acceptance.** Mode B (standard user, credential elevation) PENDING — never reached.
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
> | SHA-256 | `5ff9764663e2016b91fc46ea036939ea8c842af049bc53b8f246536d02a48a40` |
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
VERIFIED · WINDOWS RETEST REQUIRED.** Replacement EXE sha256 `5ff9764663e2016b91fc46ea036939ea8c842af049bc53b8f246536d02a48a40`.

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
REQUIRED.** Replacement EXE sha256 `5ff9764663e2016b91fc46ea036939ea8c842af049bc53b8f246536d02a48a40`.

**2026-09-06 - attempt 4, mode A: SECURE DESKTOP PASSES; post-UAC elevated input failed.**

Confirmed working on real Windows, by the user:
- genuine Windows UAC Secure Desktop is VISIBLE in the technician canvas;
- the remote mouse reaches the Secure Desktop;
- remotely clicking **Yes** is accepted by Windows;
- UAC closes and the normal desktop stream returns.

Failed next: the application UAC launched (installer / "Run as administrator")
showed its normal UI on `WinSta0\Default`, and remote clicks and keystrokes did
not reach it. Root cause: **Windows UIPI** discards synthetic input sent from a
lower integrity level than the receiving window. The applet is Medium integrity by
design (`asInvoker`, `uiAccess=false`; it must never self-elevate); the post-UAC
target is High.

Fixed by giving the Default desktop an `--input-only` SYSTEM helper - above both
Medium and High - so its `SendInput` is accepted by ordinary and elevated windows
alike, with exactly one injector per event and no second capturer. UIPI itself is
untouched. **WINDOWS RETEST REQUIRED** for the elevated-application control.
Replacement EXE sha256 `5ff9764663e2016b91fc46ea036939ea8c842af049bc53b8f246536d02a48a40`.

**2026-09-06 - attempt 5, mode A: PASSED.** Confirmed by the project owner on the
real Windows test machine:

- genuine Windows UAC Secure Desktop VISIBLE in the technician console;
- remote mouse works on the Secure Desktop;
- remotely clicking **Yes** on the genuine UAC prompt is accepted by Windows;
- UAC completes and `Winlogon -> Default` returns to normal streaming;
- **the post-UAC elevated application accepts remote input** - buttons and menus,
  including an elevated installer's Next / Back / Install / Finish.

This is the flow the whole POC exists to prove, and it is the golden checkpoint
recorded in `GOLDEN_WORKING_STATE.md`.

Mode B (standard user + separate admin credentials) has still never been run.

### Notes for whoever runs this

Two failures are worth recognising on sight (`DEV_NOTES.md` → Phase 5):

- Nothing appears on the canvas when a UAC prompt is up, but the banner shows:
  the helper started but is bound to the wrong desktop. Check that `lpDesktop`
  carries the window-station prefix — `WinSta0\Winlogon`, never bare `Winlogon`.
- The service starts and immediately stops, or the helper never appears: the
  token dance failed. `CreateProcessAsUser` returning 5 means the wrong token was
  duplicated, or `SetTokenInformation(TokenSessionId)` was skipped.

---

## MT-07 — Feature Batch 1: fullscreen, zoom, magnifier, hold/resume

**Status:** PENDING — implemented, Linux-side verified, **never run on Windows**
**Related Phase:** Feature Batch 1 (2026-09-18)
**Why it needs Windows:** the Linux suite proves what the console *sends* — the
remote pixel each click maps to at each zoom level, that the lens takes no pointer
events, that a held session forwards nothing. It cannot prove what Windows *does*
with any of it. A click that maps to the right pixel and still lands in the wrong
place on a scaled or multi-monitor desktop would pass every test in this repo.

Run it on the Windows test machine after a normal connect, with the applet's
folder excluded in Defender as usual.

### TEST 1 — normal control still works (regression baseline)

Do this FIRST, before touching any new control. If it fails, stop: the batch has
broken something that used to work.

1. Connect a real Windows customer and accept consent.
2. Move the mouse to the centre of the screen — the remote cursor tracks it.
3. Click all four corners: Start button (bottom-left), the clock (bottom-right),
   and the top-left and top-right corners of a maximised window.
4. Type a sentence into Notepad, including capitals and punctuation.
5. Right-click the desktop — the context menu appears **where you clicked**.
6. Drag a desktop icon from one side of the screen to the other.
7. Scroll a long document with the wheel, both directions.

**Expected:** identical to MT-03. Anything different is a regression, not a feature.

### TEST 2 — zoom (the one that matters most)

For **each** of Fit, 50%, 75%, 100%, 125%, 150%, 200%:

1. Select the level in the toolbar's zoom control.
2. Click the **Start button** — the Start menu opens. Close it.
3. Click the **close (X) button** of a maximised window — it closes.
4. Click the centre of a dialog's OK button.
5. Above 100%, scroll the remote viewport and repeat (3) — the scroll offset must
   not shift where clicks land.

**Expected:** every click lands exactly where the pointer is, at every level. The
remote desktop's own resolution must never change — check Windows Display Settings
still reads what it read before.

**If a click lands off by a consistent proportion, stop and report it**: that is
the failure mode this whole batch was written to avoid.

### TEST 3 — fullscreen

1. Press Fullscreen. The remote desktop fills the screen; the sidebars are gone.
2. Control the machine: click, type, drag. All must work exactly as before.
3. Press Esc (and, separately, the Exit Fullscreen control in the title strip).
4. Confirm the previous layout, the previous zoom level and the session all return,
   and that control still works afterwards.

### TEST 4 — magnifier

1. Enable Magnifier. Move over small text — the lens magnifies what is under the
   pointer, and follows it.
2. **Click through the lens** on a button — the click reaches the remote machine.
3. **Drag through the lens** — the drag works normally.
4. Type while the lens is up — keystrokes still arrive.
5. Disable Magnifier; the lens disappears and nothing else changes.

### TEST 5 — hold / resume

1. With a live session, press Hold.
2. Confirm on the **customer's** machine: the applet's session indicator says the
   technician has paused remote control.
3. Move the mouse and type in the console — **nothing happens on the customer's
   machine**. Watch the customer's screen directly, not the console's copy.
4. Confirm the customer's screen is still streaming to the console.
5. Try to run a script and to elevate — both must be refused, not silently ignored.
6. Press Resume. Control returns; the indicator says so.
7. Repeat, and press **End** while held — the session must tear down completely
   (service uninstalled, applet gone, nothing left at reboot).

### TEST 6 — UAC regression (the golden path)

After all of the above, in one session:

1. Elevate using the existing working path (mode A, local admin).
2. Trigger a UAC prompt on the customer's machine.
3. **The Secure Desktop prompt is visible in the console.**
4. Click Yes on it, remotely.
5. Confirm the return to the user's desktop, resumed streaming, and that you can
   still drive the elevated application's buttons and menus.

**Expected:** exactly the behaviour recorded in `GOLDEN_WORKING_STATE.md`. Feature
Batch 1 did not change any privileged-control component; this test exists to prove
that claim on real hardware, not to re-qualify UAC.

**Also check:** hold/resume while elevated — Hold must not drop elevation, and the
console must not offer elevation again while held.

---

## MT-08 — Feature Batch 2: chat, Send URL, predefined replies, history & notes

**Status:** PENDING — implemented, Linux-side verified (`ws/09-chat` 34/34,
`browser/23-chat` 43/43), **never run on Windows**.
**Related Phase:** Feature Batch 2 (2026-09-18)
**Why it needs Windows:** the Linux suite proves what the console *sends* and
*renders*, and what the relay *forwards* — it cannot prove that the applet's
own chat window (`windows/Applet/Forms/ChatForm.cs`) actually appears, reads
correctly, or that a link opens in a real default browser on a real desktop.

Run it on the Windows test machine after a normal connect, with the applet's
folder excluded in Defender as usual. Do this AFTER MT-07, in the same session
if convenient — nothing here needs a fresh connect.

### TEST 1 — chat, both directions

1. Connect and consent as usual. On the console, open the **Chat** tab
   (toolbar or the tab itself).
2. On the customer's machine, the session indicator now has a **Chat** button
   below End Session. Click it — a small chat window opens near the
   indicator.
3. Technician types a message and presses Enter. **Expected:** it appears in
   the customer's chat window within a second or two, attributed to the
   technician.
4. Customer types a reply and presses Enter (or clicks Send). **Expected:** it
   appears in the technician's console, attributed to the customer.
5. Customer clicks the indicator's Chat button again — the window hides
   (session keeps running). Click it once more — it reopens, and the whole
   conversation is still there.
6. Customer closes the chat window with its own X button. **Expected:** it
   only hides (same as step 5) — it does NOT end the session, and the
   indicator with End Session is still there and unaffected.

### TEST 2 — keyboard isolation (the one that matters most)

1. With the customer's desktop showing a text editor (Notepad is fine), click
   the remote screen in the console and type a sentence. **Expected:**
   identical to MT-03 — it reaches Notepad on the customer's machine.
2. Click into the console's **Chat composer** and type a full sentence,
   including capitals, punctuation and at least one word that would trigger a
   special key on the customer's machine if it leaked (e.g. type "ALT TAB" as
   plain text, not the key combo).
   **Expected:** nothing happens on the customer's desktop while typing this —
   watch the customer's screen directly. Press Enter to send it as a chat
   message; still nothing happens on the desktop other than the chat window
   updating.
3. Repeat step 2 in the **Notes** textarea, the **Predefined Replies** editor
   (Manage), and the **Send URL** dialog's URL/label fields.
4. Click the remote screen again and type another sentence. **Expected:**
   normal typing resumes exactly as in step 1 — nothing was left stuck or
   disabled by steps 2–3.

**If any keystroke from steps 2–3 reaches the customer's desktop, stop and
report it immediately** — this is the one regression this whole batch cannot
tolerate.

### TEST 3 — Hold

1. Place the session on Hold (as in MT-07 TEST 5).
2. Confirm chat still works in both directions while held (repeat TEST 1
   steps 3–4).
3. Confirm remote mouse/keyboard control is still blocked while held
   (unchanged from MT-07).
4. Resume. Confirm control returns and the chat conversation is untouched.

### TEST 4 — Send URL

1. From the console's Chat tab (or the Send URL toolbar button), send an
   `https://` link with a display label.
2. **Expected on the customer's side:** the link appears in their chat window
   as underlined/clickable text. It does **NOT** open a browser by itself.
3. Customer clicks the link themselves. **Expected:** it opens in their
   default browser.
4. From the console, attempt to send `javascript:alert(1)` in the Send URL
   dialog. **Expected:** the console itself refuses it before anything is
   sent (an error appears in the dialog, nothing reaches the customer).

### TEST 5 — predefined replies

1. In the console's Chat tab, select a quick reply from the dropdown.
   **Expected:** the composer is populated with that text and nothing is sent
   yet.
2. Edit the text (add or change a word), then press Enter.
   **Expected:** the customer receives the EDITED version, proving the review
   step is real.
3. Click Manage, add a new quick reply, confirm it appears in the dropdown;
   edit it; remove it. Confirm each change persists after closing and
   reopening the Manage panel.

### TEST 6 — notes / history privacy

1. In the console's Notes tab, type a note and click Save Notes.
   **Expected:** a brief "Saved" confirmation; nothing appears on the
   customer's screen or in their chat window as a result.
2. Switch to another inspector tab and back to Notes. **Expected:** the note
   is still there.
3. Confirm the History timeline shows real events (session created, consent,
   chat started, etc.) — nothing fabricated.
4. End the session and start a new one with the same or a different customer.
   **Expected:** the new session's Notes tab is empty — nothing from the
   previous customer's session carried over.

### TEST 7 — UAC regression (the golden path)

With an active chat conversation open, in the same session:

1. Elevate using the existing working path (mode A, local admin).
2. Trigger a UAC prompt on the customer's machine.
3. **The Secure Desktop prompt is visible in the console**, exactly as before.
4. Click Yes on it, remotely; confirm the return to the user's desktop and
   resumed control of the elevated application.
5. Confirm chat still works after elevation (send one message each way) —
   Feature Batch 2 must not have disturbed the privileged-control path, and
   this proves it on real hardware rather than assuming it from the source.

**Expected:** exactly the behaviour recorded in `GOLDEN_WORKING_STATE.md`.
Nothing under `windows/Applet/{Capture,Input,Elevation,Scripting}` or the
Secure-Desktop chain changed in this batch.

---

## MT-09 — Admin-portal release against a real Windows machine

**Status:** PENDING — implemented and Linux-verified (`./scripts/run-tests.sh`:
39 blocks green, including `api/30`–`34` and `browser/24`), **never run on
Windows or against a real Entra tenant**.
**Why it needs a human:** the Linux suite uses the development sign-in form and
a simulated applet. It cannot prove that real Entra sign-in works for your
tenant, that the real applet shows the new name and notice, or that the
privileged path still behaves after the rebuild.

Prerequisites: the deployment is on `https://app.<domain>` and
`https://admin.<domain>` with Entra configured (`docs/ENTRA_SETUP.md`); one
Admin and one Agent account assigned in Entra; the applet rebuilt with
`./scripts/build-windows.sh` for `app.<domain>`.

| # | Step | Expected | Actual result |
|---|---|---|---|
| 1 | Admin signs in at `https://admin.<domain>` | Microsoft sign-in; lands on Overview; no "Development sign-in" badge |  |
| 2 | Agent signs in at `https://app.<domain>` | "Waiting for an administrator to approve" |  |
| 3 | Admin: Agents & access → Pending → Review & activate (agent ID, team) | Agent listed as active |  |
| 4 | Agent signs in again; New Session | Console header shows the agent's real name and agent ID |  |
| 5 | Agent tries `https://admin.<domain>` | Refused: "for administrators, supervisors and auditors" |  |
| 6 | Customer downloads and runs the applet, enters the code | **Consent dialog names the agent's Entra display name** (not "Support Agent") |  |
| 7 | Customer accepts; open the applet's Chat window | Second line reads "Messages here are saved to the support session record." Chat works both ways |  |
| 8 | Repeat MT-06 mode A briefly: request elevation, click Yes on the real UAC prompt remotely | Unchanged from the golden checkpoint: Secure Desktop visible, click works, return to Default, elevated app controllable |  |
| 9 | Customer clicks **End Session** on the indicator | Session ends on both sides; admin portal → history shows end reason **Ended by customer** |  |
| 10 | Admin opens the session detail | Timeline includes consent, elevation requested/result, desktop changed, session ended; View transcript shows the chat |  |
| 11 | Admin: Download PDF report → Reports → Download | PDF opens; contains timeline and chat; **no** six-digit code, **no** passwords |  |
| 12 | Admin suspends the agent while the agent runs a new live session | Agent console shows access revoked; the customer's indicator closes; history shows "Technician access revoked" |  |
| 13 | Credential-mode elevation (MT-06 mode B) with a throwaway admin password, then search: `docker compose exec db pg_dump -U helpdesk helpdesk \| grep -c '<password>'` and `grep -r '<password>' audit/` | Both **0** |  |

Steps 6–9 and 13 are the ones only a real Windows machine can answer.

---

## MT-10 — Staging web walkthrough (no Windows, no Entra)

**Status:** PENDING — human walkthrough. The same flow passed automatically
against staging on 2026-09-27 (`browser/24` 32/32, `api/30` 78/78, `api/33`
44/44 run against `hda-staging`). This test is you confirming it by hand.

Setup: on the VM `./scripts/staging.sh reset`; on your workstation
`ssh -L 18080:127.0.0.1:18080 -L 18081:127.0.0.1:18081 ubuntu@<vm>`. The customer
is the mock applet in a VM shell:
`node scripts/mock-host.js <code> --url ws://localhost:18080/ws --machine கணினி-PC --user முருகன் --chat`.
All sign-ins use the **development form**; "object ID" is any GUID-like text.

| # | Step | Expected | Actual result |
|---|---|---|---|
| 1 | Open http://localhost:18081 | Admin portal sign-in page (light, "Administration portal") |  |
| 2 | Sign in: object ID `aaaaaaaa-0000-4000-8000-000000000001`, name "Ada Admin", role **Admin** | Overview dashboard, "Development sign-in" badge |  |
| 3 | Open http://localhost:18080 in a **private window**; sign in: object ID `bbbbbbbb-0000-4000-8000-000000000002`, name "Bob Agent", role **Agent** | "Waiting for an administrator to approve" |  |
| 4 | Admin → Agents & access → Pending → Review & activate: agent ID `AG-001` → Activate | Bob listed Active |  |
| 5 | Bob signs in again (step 3 values) | Technician console; header shows "Bob Agent · AG-001 · Agent" |  |
| 6 | Bob: New Session; in the VM run the mock-host command with the code | Console: "Connected"; mock prints `agentName":"Bob Agent"` in `host.connectRequest` |  |
| 7 | Bob: Chat tab → send "Hello வணக்கம்"; in the mock type "நன்றி! Printer not working" + Enter | Both messages appear on both sides; console chat header says chat is saved |  |
| 8 | Bob: Notes tab → type a note (Tamil or English) → Save Notes | "Saved" |  |
| 9 | Bob: End | Session ends on both sides |  |
| 10 | Admin → Session history → open the session | Timeline: created, customer joined, consent, active, notes saved, ended (Ended by technician) |  |
| 11 | View transcript; View notes | Tamil and English shown as typed |  |
| 12 | Download PDF report → Reports → Download; open the PDF | Tamil and English render correctly (no `?`), timeline present, **no 6-digit code** |  |
| 13 | Bob, in a private window, opens http://localhost:18081 and signs in with role Agent | Refused: "for administrators, supervisors and auditors" |  |
| 14 | Bob starts a new session, mock joins and consents; Admin → Agents & access → Active → Bob → Suspend | Bob's console shows access revoked; the mock prints the socket closing; history shows "Technician access revoked" |  |
| 15 | Bob tries to sign in again | "Your access … is suspended" |  |
| 16 | Admin → Audit trail | activation, transcript.viewed, notes.viewed, report.requested/downloaded, access.suspended present |  |


## MT-11 — Multi-session: four customers, one technician

**Status:** PENDING — implemented, Linux-side verified (`ws/10` 56/56, `ws/10b` 7/7,
`browser/26` 48/48, `source/27` 10/10), **never run on Windows**.
**Related:** `docs/MULTI_SESSION.md` (2026-09-28)
**Why it needs Windows:** the Linux suite drives four applet-shaped sockets through the
real relay and a real console, but only real applets prove real screens, real input
injection and the UAC path with four sessions open at once.

**Setup.** Up to four Windows machines or VMs (two is enough for most rows; four for the
limit rows), each running the applet. **Which build:** the verified golden exe
(`435bbe5f…`) is fine for every row except the two chat rows — that build predates
applet-side chat (Feature Batch 2). For the chat rows use a build of the current source
(`./scripts/build-windows.sh`), which also exercises MT-08.

| # | Test | Expected result | Actual result |
|---|---|---|---|
| 1 | Start one remote session | Session connects normally; one tab, "Active Sessions: 1 / 4" |  |
| 2 | Start a second session (PC 2) | Both remain connected; two tabs |  |
| 3 | Start a third session | All three remain connected |  |
| 4 | Start a fourth session | All four remain connected; New Session and + disabled; "4 / 4" |  |
| 5 | Try a fifth (force it: a second console window on the same account) | Refused — "Session limit reached" dialog; no existing session affected |  |
| 6 | Switch session tabs (click, and Ctrl+Shift+1…4) | Other connections stay live (tab clocks keep running); the switch keys reach no PC |  |
| 7 | Control Session 1: move, click, type in Notepad | Only PC 1 moves/types |  |
| 8 | Control Session 2 the same way | Only PC 2 moves/types |  |
| 9 | Hold Shift in Session 1, press Ctrl+Shift+2, release | PC 1 has no stuck Shift (type on PC 1 afterwards: lower case) |  |
| 10 | Chat in Session 1 (current-source build) | Only PC 1's chat window shows it |  |
| 11 | Customer on PC 3 sends a chat while Session 1 is selected | PC-3 tab shows an unread badge and a notification; Session 1 does not switch |  |
| 12 | Transfer a file in Session 2 | **N/A — file transfer is a separate follow-up** |  |
| 13 | Disconnect Session 3 with its ✕ | PC 3's indicator closes; 1, 2, 4 stay connected; "3 / 4"; New Session enabled |  |
| 14 | Session 2 network loss: disable PC 2's network adapter for ~20 s, then re-enable | Customer-side drop: only Session 2 ends; the others are unaffected |  |
| 15 | Technician network loss: disconnect the technician's Wi-Fi for ~15 s, then reconnect | Every tab shows Reconnecting, then Connected again; all customers stay connected throughout |  |
| 16 | Reload the console page (F5) with 3 sessions open | All three come back connected with their pictures; customers notice nothing |  |
| 17 | UAC in Session 1 (Run as administrator → approve remotely) | UAC Secure Desktop visible and clickable in Session 1; other sessions unaffected and still controllable after switching |  |
| 18 | UAC prompt appears on PC 2 while Session 1 is selected | Notification "UAC prompt on the customer's screen" for PC 2; clicking it switches |  |
| 19 | Grid view with 4 sessions | Four live thumbnails; one "CONTROL ACTIVE"; clicking another tile selects it and sends no click |  |
| 20 | Close the technician's browser tab unexpectedly | Within ~60 s every customer's session ends; admin portal Live shows them "technician reconnecting" meanwhile, then gone |  |
| 21 | Disconnect all | Confirmation dialog; Cancel ends nothing; confirm ends all four |  |
| 22 | Admin portal → Live sessions → Technicians | Technician row "4 / 4" (or current count); drill-down lists each PC, state, duration, chat count |  |

**Combined scenario (all at once):** Session 1 on the elevated UAC screen, Session 2
running a long script (`1..30 | % { $_; Start-Sleep 1 }`), Session 3 chatting (current-source
build), Session 4 under normal remote control. Switch between all four repeatedly for two
minutes. Expected: every operation continues independently; script output lands only in
Session 2's pane; no input ever appears on the wrong PC.

---

## MT-12 — Security & reliability audit 2026-10-05

**Status: PENDING** (not run — needs Windows hardware and a real Entra tenant).

The table of checks lives in `docs/audit/MANUAL_TEST_PLAN.md` (T-01 … T-16). The
one that is new to this audit and touches the golden Windows area is **T-05**:
"Run as SYSTEM" scripts after the F-01 staging fix, run as a standard user with
credential-mode elevation. Run T-04 alongside it to confirm golden UAC behaviour
is unchanged.

---

## MT-13 — Technician Platform 2.0, Phase 1 (dashboard, lifecycle, health) + golden regression

**Status:** PENDING — implemented, Linux-side verified (`unit/40`, `ws/12`, `browser/41`,
`source/42`, full suite green), **never run on Windows**.
**Related:** `docs/technician-console.md`, `docs/session-lifecycle.md`, `docs/golden-features.md`.
**Applet:** unchanged by Phase 1 (no file under `windows/` changed). Any build that already
passed MT-01/02/03/06A is a valid customer side; the point of this test is the new console
against a real desktop, and that the verified UAC flow is untouched.

| # | Test | Expected result | Actual result |
|---|---|---|---|
| 1 | Sign in to the console | Idle screen shows Active / Waiting / Reconnecting / Completed today and recent sessions |  |
| 2 | New Session | Card shows PIN as two groups of three, "Expires in 09:5x" counting down, Copy PIN / Link / Invitation |  |
| 3 | Copy Invitation, paste into Notepad | Message with your name, the PIN and the join link — nothing else |  |
| 4 | Customer runs the applet, enters the PIN | Card disappears; header shows the machine · OS and `HDA-xxxxxxxx` |  |
| 5 | Customer accepts consent | Screen streams; status bar Connection shows Excellent/Good with a latency in ms within ~5 s |  |
| 6 | Move the mouse, type in Notepad | Works as before; Info tab → Lifecycle phase CONTROLLING |  |
| 7 | Zoom − / + | Steps Fit → 100 % → 125 % …; clicks still land where pointed at every level |  |
| 8 | Hold, then Resume | Info shows ON_HOLD, then CONNECTED; input blocked while held, as before |  |
| 9 | Dashboard (strip) with 1 session | Cards, queue row with user / device / Connected / duration; clicking it switches |  |
| 10 | Open 4 sessions (3 can stay waiting) | Dashboard: "4 / 4", limit message, New Session disabled; a 5th is refused |  |
| 11 | End a session | Dashboard history gains it as Completed; Completed today +1 |  |
| 12 | **Golden regression** — run the full checklist in `docs/golden-features.md` (Run as administrator → UAC Secure Desktop visible → remote Yes → elevated app controllable → back to Default → Ctrl+Alt+Del → disconnect → cleanup) | Every row PASS. **Any UAC regression is a release blocker** — diff against the golden tag first. |  |
| 13 | Technician Wi-Fi off ~15 s, then on | Status bar shows Reconnecting, then a fresh latency; customer unaffected |  |

---

## MT-14 — Technician Platform 2.0, Phase 2 (server/console half): scripts, activity, screenshot

**Status:** PENDING — implemented, Linux-side verified (`ws/13`, `browser/43`, `browser/44`,
`source/42`), **never run on Windows**. Applet unchanged — any build that passed MT-01–03 is fine.
Doubles as most of **MT-04** (real PowerShell, streamed output, timeout).

| # | Test | Expected result | Actual result |
|---|---|---|---|
| 1 | Scripts → Saved scripts → *Computer summary* → Run | Real output from the customer PC; status "Finished · exit code 0 · n s"; output header names the script |  |
| 2 | *IP configuration* (Command Prompt) | `ipconfig /all` output |  |
| 3 | Elevate (mode A), then *Restart Print Spooler* (runs as SYSTEM) | Spooler restarts; output shows Status Running |  |
| 4 | Edit a loaded script by one character, Run | Runs; Activity shows a plain script, not the saved name |  |
| 5 | Ad-hoc `1..150 \| % { $_; Start-Sleep 1 }` | Output streams; stops at ~120 s with "Stopped — timed out" |  |
| 6 | Activity tab | Created, customer joined, consent, each script by name, exit codes, elevation, UAC desktop changes |  |
| 7 | Screenshot (camera button) | A PNG of the remote screen downloads on the technician PC; Activity shows "Screenshot captured"; nothing appears on the customer side |  |
| 8 | Chat tab | System lines for connected / elevated / screenshot visible to the technician only; the customer's chat window shows none of them |  |
| 9 | Two sessions: run a script on A, switch to B | B's Scripts status, editor and Activity show nothing of A's |  |
| 10 | Admin portal → Script library: create a script, edit it (v2), archive it | Technicians see v2 in the console, then nothing after archive; Audit trail shows created / updated / archived with a hash, not the text |  |
| 11 | System tab | Computer name, user, OS, privilege (Elevated after step 3), desktop, resolution |  |

---

## MT-15 — Technician Platform 2.0, Phase 2b: the new applet (files, clipboard, system, Stop)

**Status:** PENDING — implemented, Linux-verified (`ws/14` 54/54, `browser/45`, `source/45`,
`dotnet/PathPolicyTests`, Windows solution builds), **never run on Windows**.
**This is the first changed applet of 2.0.** It must be built against a server running this
branch, with `--out` so the live download is not replaced:

```bash
./scripts/build-windows.sh --server https://<server running feature/technician-platform-v2> --out ~/hda-artifacts/platform-v2
```

Record the build's SHA-256 next to the results. Run on a throwaway Windows VM with the usual
Defender path exclusion.

**Part 1 — golden regression first (release blocker).** Walk the whole checklist in
`docs/golden-features.md` with THIS build: launch, PIN, consent, screen, mouse, keyboard,
Run as administrator → UAC Secure Desktop visible → remote Yes → elevated app visible and
controllable → back to Default → Ctrl+Alt+Del → disconnect → service removed and
`%ProgramData%\HelpdeskAnywhere` gone. **Stop at the first failure** and diff against golden.

**Part 2 — new features.**

| # | Test | Expected result | Actual result |
|---|---|---|---|
| 1 | Toolbar: File manager, Clipboard, System info | Enabled (an old applet build shows them greyed with "older app" tooltip) |  |
| 2 | File manager start view | Desktop, Documents, Downloads, local drives |  |
| 3 | Open Documents; upload a 50 MB file (file picker) | Progress, speed, completes; file in Documents, opens fine; customer indicator says a file arrived |  |
| 4 | Upload the same name again | Arrives as "name (1).ext"; original untouched |  |
| 5 | Upload with no folder open | Lands in `Downloads\Helpdesk Anywhere` |  |
| 6 | Cancel a large upload half-way | No `.hdapart` file left in the folder |  |
| 7 | Download a file from the customer PC | Saved by the technician's browser, opens fine; customer indicator says so |  |
| 8 | New folder, rename it, delete it | Each works; customer indicator says so; a non-empty folder refuses delete |  |
| 9 | Browse C:\Windows\System32\config, try to download SAM | Access denied (runs as the user — expected) |  |
| 10 | Type `\\server\share` or `C:\Windows\..\` in the path box | "That path is not allowed." |  |
| 11 | Clipboard → Send text → paste in Notepad on the customer PC | Text pastes; indicator mentions it |  |
| 12 | Copy text on the customer PC → Clipboard → Get | Text appears; indicator says it was read |  |
| 13 | System → Collect details | Windows edition/build, CPU, memory, disks, network, uptime, battery (laptop) |  |
| 14 | Run `1..600 \| % { $_; Start-Sleep 1 }`, press Stop | Script ends at once with "[stopped by the technician]"; no orphan powershell.exe in Task Manager |  |
| 15 | End Session during an upload | Session ends normally; no partial file left; nothing else left running |  |
| 16 | Admin portal → agent → untick "May transfer and manage files" | That technician's File manager is refused (Clipboard still works) |  |
| 17 | Activity tab / session report | Each transfer (name, size, result), folder changes, clipboard (length only), system details, Stop |  |

---

## MT-16 — Technician Platform 2.0, Phase 3: customer network drop

**Status:** PENDING — Linux-verified including the applet's real `SessionClient` against the real
relay (`dotnet/ReconnectTests`), **never run on Windows**. Same build as MT-15.

| # | Test | Expected result | Actual result |
|---|---|---|---|
| 1 | Connected session; disable the customer PC's network adapter for ~15 s, then enable | Customer indicator: "Connection lost — reconnecting…" (stays up); console tab "Customer reconnecting"; then both back to normal; screen and control resume; no new consent prompt |  |
| 2 | Same, but while the session is **elevated** | After return, UAC prompts still visible and controllable; elevated service still present; Ctrl+Alt+Del still works |  |
| 3 | Same, while **on hold** | Comes back on hold |  |
| 4 | Network off for > 70 s | Session ends on both sides; elevated service removed; nothing left running |  |
| 5 | Upload a large file, drop the network mid-transfer | Transfer marked failed in the console; no `.hdapart` left once back |  |
| 6 | Customer clicks End Session | Ends at once (no reconnect attempt) |  |
| 7 | Old (golden) applet build, network drop | Session ends at once, exactly as before |  |
| 8 | Activity / report | "Customer connection lost — reconnecting", "Customer reconnected" entries |  |

