# Migration Test Plan

Run this against the **new VM** after `restore-new-vm.sh` and
`verify-migration.sh` both pass. Automated checks (`verify-migration.sh`)
cover connectivity/health; everything below needs a human and, for the
Windows-specific rows, a real Windows test machine (CLAUDE.md — "Windows
code cannot be compiled-and-run-tested on Ubuntu").

The six rows marked **CRITICAL** are the ones CLAUDE.md and
`GOLDEN_WORKING_STATE.md` call out as having taken real, hard-won Windows
testing to get right. If any of these regress, stop, compare against the
golden tag before changing anything:

```
git diff hda-windows-privileged-control-working-2026-09-06..main -- windows/
```

| # | Test | Expected Result | Critical |
|---|------|------------------|----------|
| 1 | Web console opens (`https://<new-host>/`) | PASS |  |
| 2 | HTTPS certificate valid (no browser warning) | PASS |  |
| 3 | Login works (CONSOLE_USER/CONSOLE_PASSWORD) | PASS |  |
| 4 | Technician can create a session | PASS |  |
| 5 | Session code generated (6 digits, join link works) | PASS |  |
| 6 | Windows client launches (rebuilt with new host's URL) | PASS |  |
| 7 | Windows client connects to the new server | PASS |  |
| 8 | User consent prompt works (names the agent, no stream before Accept) | PASS |  |
| 9 | Screen sharing works | PASS | **CRITICAL** |
| 10 | Mouse control works | PASS | **CRITICAL** |
| 11 | Keyboard control works | PASS | **CRITICAL** |
| 12 | Clipboard works (if currently supported) | PASS |  |
| 13 | Chat works (if currently supported) | PASS |  |
| 14 | File transfer works (if currently supported) | PASS |  |
| 15 | UAC prompt visible (genuine Secure Desktop, not a fake overlay) | PASS | **CRITICAL** |
| 16 | UAC Yes can be clicked remotely | PASS | **CRITICAL** |
| 17 | Elevated installer remains controllable post-UAC (buttons/menus respond) | PASS | **CRITICAL** |
| 18 | Session termination works (one click, from the indicator) | PASS |  |
| 19 | Reconnection works | PASS |  |
| 20 | Audit record created (session start/stop, consent, elevation, scripts) | PASS |  |
| 21 | No major console/server errors (`docker compose logs app`) | PASS |  |

## Notes on the CRITICAL rows

These exercise exactly the invariants in `GOLDEN_WORKING_STATE.md` §9:
genuine UAC, Secure Desktop enabled, UIPI untouched, nothing auto-clicked,
the applet never self-elevating. A migration should not change any of this
— the server is only a relay — but verify anyway, because:
- the new VM's network path (new tunnel/DNS) changes round-trip timing,
  which has historically surfaced timing-sensitive bugs in this codebase
  (see DEV_NOTES.md's account of MT-06);
- the applet is being rebuilt with a new baked-in `SERVER_URL`, which is a
  real code-path change (not just config) worth re-verifying end to end.

## Two-account requirement (per CLAUDE.md)

Row 15–17 should be exercised against **both** Windows test accounts:
- a local administrator account (interactive Yes/No consent — elevation mode A)
- a standard user account with separate admin credentials typed into the
  console (credential-mode elevation — mode B, PLAN 5.2b)

Elevation via credential-mode additionally requires: the connection is WSS
(never plain `ws://`), and after the test, grep every log on the new VM for
the throwaway admin password used — it must not appear:

```bash
grep -r "<throwaway-admin-password>" "$(pwd)"/audit/ 2>&1
docker compose logs app 2>&1 | grep "<throwaway-admin-password>"
```
Both should return nothing.

## Sign-off

Do not retire the old VM until every CRITICAL row is PASS on the new VM with
a real Windows test machine, and `verify-migration.sh` is clean.
