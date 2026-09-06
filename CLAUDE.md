# Helpdesk Anywhere — Project Context

## What this is
A LogMeIn Rescue-style attended remote support tool, built as a POC.

A support agent opens a **browser-based console**, generates a 6-digit session code,
and shares a download link. The end user downloads a small Windows applet, runs it,
types the code, and approves a consent prompt. The agent then sees and controls that
machine — **including UAC / Secure Desktop prompts** — and can run remote scripts.

## Non-negotiable design constraints
These are what make this a legitimate support tool rather than spyware. Do not
remove or make configurable-off:

1. **Explicit consent before every session.** The applet must show a modal naming the
   requesting agent, and must not stream anything before the user clicks Accept.
2. **Always-visible session indicator.** While a session is live, the applet shows a
   persistent, non-hideable window/tray indicator. The user must always know they are
   being viewed.
3. **User can end the session at any time**, with one click, from that indicator.
4. **No stealth, no hidden install, no persistence.** The applet is a one-shot process.
   The elevated helper service is installed at session start and **uninstalled at
   session end**. Nothing survives reboot.
5. **Audit log** of session start/stop, consent decisions, elevation attempts, and every
   executed script, written server-side.
6. **Credentials are never logged or retained.** The agent can supply admin credentials
   to elevate (see `PLAN.md` 5.2b) — a legitimate and necessary helpdesk feature, since
   it avoids revealing the admin password to the end user. But that payload must never
   reach any log, must not be persisted or buffered by the relay, must be zeroed after
   use, and must be refused outright over a non-TLS connection. Elevation must also be
   surfaced on the user's session indicator — the user consented to being helped, not to
   silent privilege escalation.

## Architecture

```
┌────────────────────────┐         ┌──────────────────────────────────┐
│  Agent console         │  WSS    │  Ubuntu VM (Docker + Caddy)      │
│  (browser, any OS)     │◄───────►│  https://<name>.duckdns.org      │
│  canvas render + input │  :443   │  - Agent portal (static + API)   │
└────────────────────────┘         │  - Session store + code gen      │
                                   │  - WS signaling + stream relay   │
┌────────────────────────┐  WSS    │  - Serves applet .exe download   │
│  Windows applet (.exe) │◄───────►│  - Let's Encrypt TLS (automatic) │
│  capture/input/UAC/exec│  :443   └──────────────────────────────────┘
└────────────────────────┘
```

The Linux server is **only a matchmaker + relay + file host**. All screen capture,
input injection, UAC handling and script execution happen inside the Windows applet.
Both endpoints dial *out* to the server over WSS/443, so no inbound firewall rules or
NAT traversal are needed on either client.

## Tech stack (chosen for "develop entirely on Ubuntu")

| Component | Stack | Why |
|---|---|---|
| Server | Node.js 22 LTS + TypeScript, Express + `ws` | Runs natively on Ubuntu, trivial in Docker |
| Agent console | Plain HTML/JS + `<canvas>` | No build step, no framework, runs in any browser |
| Windows applet | C# / .NET 8 (`net8.0-windows`), WinForms for dialogs | **Cross-compiles to a Windows .exe from Ubuntu** via `dotnet publish -r win-x64`; P/Invoke gives full Win32 API access |
| Container | Docker + docker-compose, Caddy for TLS | Let's Encrypt automation with near-zero config |
| Public URL | Free DuckDNS subdomain → cloud VM IP | Real HTTPS cert on a stable, shareable hostname (see below) |

## Public URL and TLS — decided, do not substitute

The server is reached at **`https://<name>.duckdns.org`** — a free DuckDNS subdomain
pointed at the cloud VM's public IP, with Caddy obtaining a Let's Encrypt certificate
automatically. Session links are path-style: **`https://<name>.duckdns.org/j/482913`**
(easier to read aloud on a support call than a query string).

**Do not fall back to a bare IP over plain HTTP.** Two concrete failures:
1. Chrome blocks executable downloads whose URL is plain HTTP ("Insecure download
   blocked"), adding a third confusing click for a non-technical end user on top of
   SmartScreen's "Run anyway" and the UAC approval.
2. Phase 5 moves **administrator credentials over this connection** — both typed into a
   remote UAC prompt as keystrokes, and sent directly by the agent in credential-mode
   elevation (`PLAN.md` 5.2b). Without TLS those cross the public internet in cleartext,
   along with every screen frame. Credential-mode elevation is therefore hard-refused on
   a non-`wss:` connection.

Bare-IP HTTPS *is* now possible (Let's Encrypt made IP-address certificates generally
available in January 2026, via Certbot 5.3+ `--ip-address`), but only under the
`shortlived` profile at ~160-hour lifetimes, and it needs Certbot driving renewal
instead of Caddy's zero-config auto-TLS. More moving parts, uglier URL, no benefit.

**The applet .exe is served from the VM by Caddy**, not from S3. `build-windows.sh`
drops it straight into `server/public/download/`, so the dev loop and the product flow
are the same path, and one TLS setup covers both the download and the session traffic.
If S3 is ever introduced, use **presigned URLs with a short expiry** — never a public
bucket. A permanently public, unauthenticated, unsigned remote-control binary is
directly useful to tech-support scammers, with your account attached to it.

**Why C# and not Go/Rust/C++:** the .NET SDK on Linux can produce a self-contained
Windows executable with no Windows machine and no mingw toolchain, while P/Invoke
still reaches every Win32 API this project needs (`SendInput`, `BitBlt`,
`OpenInputDesktop`, `CreateProcessAsUser`, service control). Cross-compiling CGO or
the MSVC-targeting `windows` crate from Linux is materially more painful.

## Hard environment boundary — read before every Windows change

**Windows code cannot be compiled-and-run-tested on Ubuntu.** It cross-*compiles*
fine, but nothing that touches Desktop Duplication, `SendInput`, Winlogon desktops or
Windows services can execute under Wine or Docker. There is no substitute.

The dev loop is therefore:

1. Edit C# on Ubuntu.
2. `./scripts/build-windows.sh` — cross-compiles and drops the .exe straight into
   `server/public/download/`.
3. On the Windows test machine, re-download from the portal page and run it.

Step 3 is a **manual human step**. When a task's acceptance test requires it, stop and
ask the user to run it and report back — do not mark such a task complete on the basis
of a successful compile.

## Windows test machine requirements
- Windows 10 22H2 or Windows 11, x64. **Use a throwaway VM or spare laptop.**
- **Two local accounts, both needed** (Phase 5 must be tested against each):
  - a **local administrator** account — exercises the interactive consent prompt
    (Yes/No, no password), i.e. elevation mode A;
  - a **standard user** account plus separate admin credentials you can type into the
    agent console — exercises credential-mode elevation (mode B). This is the realistic
    corporate case and the one that deadlocks if mode B is missing.
  - Use a throwaway admin password. Phase 5's acceptance test greps every log for it.
- A Microsoft Defender **path exclusion** for the applet's folder. Expect Defender and
  SmartScreen to flag an unsigned binary that runs as SYSTEM and injects input — that
  detection is correct behaviour, not a bug. Do not attempt to evade or hide from AV;
  add an explicit exclusion on the test VM and, for any real deployment, get the binary
  properly code-signed.
- Nested virtualisation is usually unavailable on cloud free tiers, so run this VM on
  local hardware (Hyper-V / VirtualBox / VMware), not on the cloud server.

## Conventions
- TypeScript: strict mode, no `any` in committed code.
- C#: nullable enabled, `async`/`await` throughout, all P/Invoke in `*/Interop/` files.
- All wire messages are defined once in `shared/protocol.md` and mirrored in
  `server/src/protocol.ts` and `windows/Shared/Protocol.cs`. Change all three together.
- Secrets/config via environment variables only. Never commit a `.env`.
- Every phase in `PLAN.md` has an acceptance test. Do not start phase N+1 until phase
  N's test passes on real hardware.

## CRITICAL REGRESSION WARNING — WINDOWS PRIVILEGED CONTROL

**A KNOWN-GOOD GOLDEN WINDOWS VERSION EXISTS.** Read `GOLDEN_WORKING_STATE.md`
before touching anything named below.

| | |
|---|---|
| Golden tag | `hda-windows-privileged-control-working-2026-09-06` |
| Golden branch | `golden/windows-privileged-control-2026-09-06` |

As of 2026-09-06 the implementation has passed **real Windows manual testing** for:

- normal remote control (streaming, mouse, keyboard);
- genuine UAC Secure Desktop visibility in the technician console;
- remote mouse control on the Secure Desktop;
- remotely clicking **Yes** on a genuine UAC prompt;
- `Winlogon → Default` return and resumed streaming;
- **post-UAC elevated application control** — buttons and menus of a
  high-integrity installer (Next / Back / Install / Finish).

These are manual Windows acceptance results, not Linux tests. No test in this
repository can reproduce them; the Linux suite only guards the invariants behind
them.

**Before modifying any of these areas:**

```
DesktopHelper              privileged input routing
DesktopWatcher             Windows role dispatcher (Applet/Program.cs)
SessionWatcher             service/app IPC (PipeChannel, *Link, SecureDesktopBridge)
SecureDesktopService       desktop binding (OpenDesktop / SetThreadDesktop)
SecureDesktopBridge        integrity / elevation detection (ForegroundTarget)
SessionLaunch              StreamSource / DesktopGuard
InputInjector
```

the agent MUST:

1. **understand the current implementation** — `GOLDEN_WORKING_STATE.md` §3–§10
   explains why each piece is shaped the way it is, and each shape is the fix for a
   specific failure that reached a real Windows machine;
2. **preserve current behaviour** — if a change alters it, say so explicitly;
3. **add or update regression tests** (`tests/source/17`–`21`), and mutation-test
   them: break the invariant on purpose and confirm the check goes red;
4. **avoid broad rewrites** — these components look redundant and are not;
5. **document why the change is necessary** before making it.

**Never replace the working privileged-control architecture speculatively.** If
UAC visibility, Secure Desktop control, elevated application input, desktop
transitions or privileged input regress, **compare against golden first**:

```bash
git diff hda-windows-privileged-control-working-2026-09-06..main -- windows/
```

Four separate real-Windows failures were needed to arrive at this design. Three of
them were a Windows API succeeding from the caller's point of view while doing
nothing (`BitBlt` returning black, a discarded child exit code, `SendInput` refused
by UIPI). A rewrite that looks cleaner will very likely reintroduce one of them.

The security boundaries in `GOLDEN_WORKING_STATE.md` §9 are not negotiable and are
not incidental to the design: genuine UAC, Secure Desktop enabled, UIPI untouched,
nothing auto-clicked, the applet never self-elevating.

## Current status
See `PLAN.md`. Update the checkboxes there as work lands.


