# Helpdesk Anywhere — Manual Tests

Windows code cross-compiles on Ubuntu but cannot execute here (`CLAUDE.md`, "Hard
environment boundary"). Everything that needs a real Windows desktop is recorded
here instead of blocking development.

**Nothing in this file may be marked PASSED by Claude.** Only the user, having run
the test on the Windows machine, can change a status to PASSED or FAILED.

---

## MT-01 — Phase 2 applet: connect, code entry, consent

**Status:** PENDING
**Related Phase:** 2
**Related Commit:** Phase 2 commit on `main` (see `git log`)

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

_(to be filled in by the user)_

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

### Steps

1. On the Ubuntu box: `./scripts/deploy-ngrok.sh`
2. Confirm the deployment verification block at the end reports 10 passed.
3. Open the printed console URL in a browser. Expect a password prompt; sign in
   as `agent` with `CONSOLE_PASSWORD`.
4. Create a session and note the six-digit code and join link.
5. On the Windows machine, open the join link. (Free ngrok shows an interstitial
   page on first visit — click through it.)
6. Download the helper. Confirm Chrome does **not** block the download.
7. SmartScreen → More info → Run anyway. Type the code. Accept the consent prompt.
8. Work through MT-01, MT-02, MT-03 and MT-04 over this connection.
9. Back on the Ubuntu box: `./scripts/verify-audit.sh`

### Expected Result

- The console demands the password before showing anything.
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
