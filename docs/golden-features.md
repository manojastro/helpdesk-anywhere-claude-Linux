# Golden features — what Technician Platform 2.0 must not break

The authoritative record is `GOLDEN_WORKING_STATE.md` (tag
`hda-windows-privileged-control-working-2026-09-06`). This file is the short
checklist used on every 2.0 change.

## Verified on real Windows (2026-09-06)

| Feature | Evidence |
|---|---|
| Applet launches, code connects, consent gates the stream | MT-01 PASSED |
| Screen streaming | MT-02 PASSED |
| Remote mouse and keyboard | MT-03 PASSED |
| Elevation mode A (admin user, genuine UAC consent) | MT-06 mode A PASSED |
| Genuine UAC Secure Desktop visible in the console | MT-06 |
| Remote mouse on the Secure Desktop, remote **Yes** | MT-06 |
| `Winlogon → Default` return, streaming resumes | MT-06 |
| Post-UAC elevated application control (installer Next/Back/Install/Finish) | MT-06 |

Not yet verified on Windows: script execution (MT-04), credential elevation mode B,
and everything from Feature Batch 1 onwards (MT-07…MT-12).

## Protected code

Any change here needs the five steps of `CLAUDE.md` → *CRITICAL REGRESSION WARNING*
and a reviewed, hash-pinned entry in `tests/lib/approved-windows-deltas.mjs`.

```
windows/DesktopHelper/**
windows/SecureDesktopService/**          (DesktopWatcher, SessionWatcher, ServiceLink,
                                          WatcherLink, Interop/SessionLaunch)
windows/Shared/PipeChannel.cs
windows/Applet/Elevation/**              (ElevationManager, SecureDesktopBridge, ServiceControl)
windows/Applet/Capture/{GdiCapture,ScreenStreamer,StreamSource,DesktopGuard,ScreenBounds}.cs
windows/Applet/Input/InputInjector.cs
windows/Applet/Interop/{ForegroundTarget,Desktops}.cs
windows/Applet/Program.cs                (role dispatcher)
```

`GdiCapture` and `ScreenStreamer` are shared by the Secure Desktop helper, so stream
quality and monitor selection must **not** be implemented inside them. Any 2.0
Windows feature goes in new files under `windows/Applet/` and is wired from
`AppletContext.cs` / `SessionClient.cs` / `Shared/Protocol.cs`.

## Server invariants the golden flow depends on

* Nothing is relayed to the technician before customer consent.
* The credential elevation frame is forwarded before any DB write, never buffered,
  never logged, refused over non-`wss:`.
* `host.desktopChanged` and `host.elevated` reach the technician unchanged.
* `agent.input` with `kind:"sas"` reaches the applet unchanged.
* Binary frame layout `[0x01]` / `[0x02][x][y][w][h]` is unchanged.

## Regression guards (Linux)

| Block | Guards |
|---|---|
| `source/15-windows-invariants` | no persistence, teardown order, no credential logging |
| `source/17`–`21` | manifest, Secure Desktop, diagnostics, helper startup, elevated input |
| `source/25`, `source/27`, `source/28` | privileged files identical to golden except approved deltas |
| `browser/14-phase5-elevation` | console elevation panel, SAS, UAC banner |
| `ws/05-phase1-audit` | credential sentinel in no log |

These cannot reproduce the Windows results — they only catch a change that would
break an invariant behind them.

## Manual Windows regression checklist (after every phase that ships an applet)

| Test | Expected |
|---|---|
| Customer applet launches | PASS |
| PIN connection | PASS |
| Consent flow | PASS |
| Remote screen | PASS |
| Mouse control | PASS |
| Keyboard control | PASS |
| Open Run as Administrator | PASS |
| UAC Secure Desktop visible | PASS |
| Remote click Yes | PASS |
| Elevated application visible | PASS |
| Elevated application controllable | PASS |
| Return to normal desktop | PASS |
| Ctrl+Alt+Del | PASS |
| Session disconnect | PASS |
| Session cleanup (service removed, nothing in `%ProgramData%\HelpdeskAnywhere`) | PASS |

Any UAC regression is a release blocker. If one appears, diff against golden first:

```bash
git diff hda-windows-privileged-control-working-2026-09-06..HEAD -- windows/
```
