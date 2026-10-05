# Manual Test Plan — Security & Reliability Audit 2026-10-05

Companion to `SECURITY_AND_RELIABILITY_AUDIT.md`. These are the checks that need
real Windows machines, a real Entra tenant or several devices, so they could not
run in the audit environment (Ubuntu, no Windows runtime). **None of them has been
run.** "Not run — environment required" means exactly that, not "passed".

Use the hardware described in `CLAUDE.md` "Windows test machine requirements": a
throwaway Windows 10 22H2 / 11 x64 VM with a local administrator account **and**
a standard account, a throwaway admin password, and a Defender path exclusion.
Build the applet from this branch (`./scripts/build-windows.sh`), download it
from the portal, and **confirm its SHA-256** against the build output before
each run — older binaries with the same file name exist.

Where a row overlaps an existing acceptance test in `MANUAL_TESTS.md`, its MT
number is given; run the MT steps and record the result here as well.

| Test | Steps | Expected result | Actual result | Status |
|---|---|---|---|---|
| T-01 Normal connect / disconnect (MT-01, MT-02) | Technician signs in, creates a session, reads the code to the customer; customer runs the applet, enters the code, clicks **Accept**. View the screen; then click **End** in the console. Repeat, ending from the customer's indicator instead. | Consent dialog names the technician; nothing streams before Accept; indicator visible throughout; either End closes both sides within ~1 s; service and `%ProgramData%\HelpdeskAnywhere` absent afterwards. | — | Not run — environment required |
| T-02 Keyboard and mouse (MT-03) | In an active session: type in Notepad incl. Shift/Ctrl/Alt combos, AltGr if available; click, double-click, right-click, drag, wheel. Switch tabs/windows mid-drag; release keys after focus loss. | Input lands at the right coordinates; no stuck modifiers or buttons after focus changes or tab switches. | — | Not run — environment required |
| T-03 Resolution, DPI, multiple monitors (MT-02) | Change customer resolution and scaling (100 → 150 %) during a session; if two monitors, move a window across them and click on each. | Picture re-scales; clicks stay accurate on every monitor and scale. | — | Not run — environment required |
| T-04 UAC approval and elevated-app control, admin account — mode A (MT-06) | As the local administrator: request interactive elevation; on the Secure Desktop click **Yes** remotely; then launch an installer that raises UAC, approve it, and click Next/Back/Install/Finish. | Secure Desktop visible in the console; remote Yes works; return to Default resumes streaming; elevated installer accepts input. Matches golden behaviour. | — | Not run — environment required |
| T-05 Run-as-SYSTEM script after the F-01 fix — standard account, mode B (MT-04, MT-06) | As the standard user: credential-mode elevation with the throwaway admin password; run `whoami; (Get-Location).Path` with **Run as SYSTEM** in PowerShell, then `whoami & cd` in cmd. During the session list `%ProgramData%\HelpdeskAnywhere\scripts` ACL (`icacls`) from an admin prompt, and as the standard user try to create `C:\Windows\Temp\HelpdeskAnywhere-system\x.ps1` before running a script. | Output shows `nt authority\system`, working dir `…\HelpdeskAnywhere\scripts`; ACL lists only SYSTEM and Administrators; the planted Temp file is never used; after End, the directory and service are gone. Grep every log for the admin password: no hits. | — | Not run — environment required |
| T-06 Credential elevation refused on a plain customer leg (F-02) | Point an applet at a non-TLS address (dev setup only, e.g. `ws://` to a local server) with a TLS technician connection; request credential elevation. | Console shows "cannot be sent over an unencrypted connection"; applet receives no elevation request; audit record has `refused: insecure_transport`. | — | Not run — environment required |
| T-07 Chat and Send URL (MT-08) | Exchange messages both ways, including `<script>alert(1)</script>`, Tamil text, and a 4000-character message; send an `https://` link and click it on the customer side; try `javascript:alert(1)` from the console. | Text shown literally; link opens only on the customer's click; non-http(s) refused; transcript in admin portal matches. | — | Not run — environment required |
| T-08 File transfer | — | **Not applicable**: the application has no file-transfer feature. | n/a | Not applicable |
| T-09 Network interruption and technician reconnect (MT-11) | During an active session, disable the technician's network for 10 s, then restore; repeat for 90 s (beyond the 60 s grace). Also reload the console tab. | ≤60 s: session resumes with the current picture and chat history; customer unaffected. >60 s: session ends as "Technician did not reconnect in time"; customer applet exits. | — | Not run — environment required |
| T-10 Customer network interruption | Disconnect the customer's network during a session. | Session ends on both sides as customer-disconnected; service removed (watchdog within ~60 s if the applet was killed). | — | Not run — environment required |
| T-11 Four concurrent sessions and isolation (MT-11) | One technician runs four sessions to four machines (or VMs); type a distinct string into each; try a fifth create. Run the same with two technicians. | Each string appears only on its own machine; fifth create refused with the limit message; nothing ended to make room. | — | Not run — environment required |
| T-12 Sign-out ends live sessions (F-04) | With an active session, click **Sign out** in the console. In a second browser, keep another sign-in's session running. | The first browser's sessions end immediately on both sides; the second browser's session continues. (Relay-level automated equivalent: `ws/11` [F-04], passing.) | — | Not run — environment required |
| T-13 Revoking console access ends live sessions (F-03) | Admin portal → Agents → clear **Can use console** for a technician with a live session. | That technician's sessions end at once (customer applet closes); their console shows access removed; new sessions refused. (Relay-level automated equivalent: `ws/11` [F-03], passing.) | — | Not run — environment required |
| T-14 Suspension and Entra role removal | Suspend a technician mid-session; separately remove their Entra app role without suspending. | Suspension: immediate end. Role removal: takes effect at next sign-in (accepted limitation A-3). | — | Not run — environment required |
| T-15 Admin access and reports (MT-09) | Sign in to the admin portal with Admin, Supervisor (with and without a team), Auditor, and Agent identities from a real Entra tenant. Export a session PDF and a CSV; open the CSV in Excel. | Agent refused at the admin portal; team-less Supervisor sees only themselves (F-10); Auditor read-only; report downloadable only by its requester and only within the TTL; CSV shows no evaluated formulas. | — | Not run — environment required |
| T-16 Hold blocks actions | Put an active session on hold; try mouse, keyboard, a script and elevation. | Nothing reaches the customer; the indicator shows the hold; chat still works. | — | Not run — environment required |

## How to record results

Fill **Actual result** with what you observed and set **Status** to `PASSED` or
`FAILED`. Only a human running the test can mark it `PASSED`. For any
`FAILED` row involving UAC, Secure Desktop or elevated input, first compare
against the golden checkpoint:

```bash
git diff hda-windows-privileged-control-working-2026-09-06 -- windows/
```

The only privileged-area change from this audit is the script-staging block in
`windows/SecureDesktopService/ServiceLink.cs` (F-01).
