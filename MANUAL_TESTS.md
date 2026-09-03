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
