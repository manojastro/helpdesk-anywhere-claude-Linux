# Changelog

All notable changes to Helpdesk Anywhere. Newest first.

Status vocabulary: `IMPLEMENTED`, `BUILD VERIFIED`, `AUTOMATED TEST VERIFIED`,
`LINUX INTEGRATION VERIFIED`, `MANUAL ACCEPTANCE PENDING`, `MANUAL ACCEPTANCE PASSED`.

---

## MT-06 DesktopHelper died in a ~300ms restart loop — 2026-09-05

Status: DIAGNOSTICS + CRASH-LOOP FIX + DESIGN FIX · builds clean · 25 blocks / 470
assertions, 0 failures · **WINDOWS RETEST REQUIRED**

### The evidence

Second real Windows run. Elevation completed, the service ran, the watcher attached
in session 5, and the desktop switch `Default -> Winlogon` was detected correctly.
The watcher launched the helper (`pid=..., session=5, desktop=Winlogon`) and ~300ms
later logged `helper exited, restarting exitCode=?`, forever. The same loop ran
while the desktop was still `WinSta0\Default`, before any UAC prompt. No `[helper]`
lines reached the applet's unified log.

### What could and could not be proven from source

Eliminated from source: mode dispatch is correct (`--desktop-helper` routes to the
helper before any WinForms init), the command line and quoting are correct, and
there is no single-instance mutex killing the second instance. So the helper does
enter helper mode.

**Not provable from source: why the helper exits.** Two things hid it, and both are
now fixed:

1. **The real exit code was discarded.** The watcher closed the handle
   `CreateProcess` returned and then read `.ExitCode` off a `Process` looked up by
   pid, which failed — hence `exitCode=?`. The helper's own early-return codes
   (87 missing pipe, 2 OpenDesktop, 3 SetThreadDesktop, 4 pipe connect, 99
   unhandled exception, 0 pipe closed) were being thrown away, and each localises
   the failure to a specific line.
2. **The helper's pre-pipe logs went only to a staging file.** The helper cannot
   reach the applet's unified log until it connects to the pipe, and it was dying
   before that — so "no `[helper]` lines" meant "died before the pipe", which is
   most of the chain, and the staging-file record started too late to say where.

### What changed

* **Real exit code (observability).** The watcher keeps the process handle and
  reads the exit code with `GetExitCodeProcess`, logged with its human-readable
  meaning and the helper's lifetime. `exitCode=?` is gone.
* **Earliest-possible helper logging (observability).** `DiagLog.Start` is now the
  helper's first statement — before the argument check and before any Win32 call —
  and it logs `HELPER ENTRY REACHED` and the parsed args. The whole startup is
  wrapped so an exception before the pipe connects is written (type, message,
  stack) to the staging file and returns a distinct code (99) rather than
  vanishing.
* **Crash-loop protection.** A helper that dies within two seconds counts as a
  rapid failure; after five in a row on one desktop the watcher logs
  `HELPER_STARTUP_FAILED` and stops relaunching until the input desktop changes,
  with a growing backoff between attempts in between. The ~300ms infinite respawn
  cannot recur.
* **No redundant helper on the applet's own desktop (design fix).** The applet
  captures its own `Default` desktop directly (Phase 3); a helper there is a
  second capturer and a wasted pipe instance, and it was the source of the crash
  loop seen on `Default` before any UAC prompt. The watcher now launches a helper
  only for desktops the applet cannot reach (Winlogon and other secure desktops),
  while still announcing every desktop change so the applet resumes correctly.

### What this does and does not do

It makes the next Windows run self-diagnosing — the watcher will log the helper's
real exit code, and the helper's staging file will show exactly how far it got —
and it stops the runaway process loop and removes the Default-desktop failure
entirely. It does **not**, on its own, prove the Winlogon helper now stays up:
that is what the retest establishes, and the real exit code is the one piece of
evidence needed to finish the job if it does not.

No UAC bypass, no Secure Desktop weakening, no auto-click, no Defender or policy
change. Ctrl+Alt+Del still goes to `SendSAS`.

### Regression protection

`tests/source/20-helper-startup.mjs` — 33 assertions: mode dispatch precedes
WinForms init, no mutex, command-line construction and quoting, earliest logging
and the exception trap, the real-exit-code path (`GetExitCodeProcess`, no
`exitCode=?`), the crash-loop ceiling and backoff, and no helper on Default while
still announcing it. Mutation-tested: restoring `exitCode=?`, launching on Default,
removing the relaunch gate, and moving `DiagLog.Start` back each turn it red.

### Replacement binary (current Cloudflare tunnel)

| | |
|---|---|
| URL | `https://sarah-wanted-councils-lewis.trycloudflare.com/download/HelpdeskAnywhere.exe` |
| SHA-256 | `74a1d695fe3fc7d90db58e1676fd61b4d28ec399291d864aa01c6325503b9c15` |
| Size | 65,913,955 bytes |
| Endpoint | `wss://sarah-wanted-councils-lewis.trycloudflare.com/ws` |

MT-01's manifest fix verified still intact in the new binary; no ngrok/localhost
baked in; served bytes over the tunnel hash identically.

---

## MT-06 diagnostic script would not parse on Windows — 2026-09-05

Status: FIXED · PowerShell parser 0 errors · published and verified through the
live tunnel · no application code touched

### The failure

The script downloaded to the Windows test machine and Windows PowerShell refused
to parse it: "Missing closing ')'" at line 81, "Missing closing '}'" at 121,
"Unexpected token ')'" at 159, "Unexpected token 'applet'" at 160, and "The string
is missing the terminator: '." at 247. The output also contained mojibake — `a<euro>"`.

### Root cause: encoding, not syntax

The script's syntax was correct. It contained **six U+2014 em dashes** and **no
byte-order mark**.

Windows PowerShell 5.1 decodes a `.ps1` with no BOM using the system ANSI code
page, not UTF-8. On a CP1252 machine the em dash's UTF-8 bytes `E2 80 94` are read
as three characters — `U+00E2`, `U+20AC`, `U+201D` — and that last one is a **smart
right double quote, which PowerShell's tokenizer accepts as a string delimiter**.
Each decorative dash therefore opened an unterminated string, and the parse
collapsed lines later with bracket errors pointing nowhere near the actual
character.

Reproduced exactly, rather than inferred: reinterpreting the committed bytes as
CP1252 and parsing them produces the same five errors at the same five lines.

**The part worth keeping.** Parsing the broken file as UTF-8 reports **zero
errors**. A `pwsh` check on Linux — the obvious thing to add — would have declared
it healthy, because pwsh reads UTF-8 by default. The bug lives entirely in the
decoding, so validation has to model the decoding.

### Fix

Two independent measures, either of which alone would have prevented it:

* the body is now **pure ASCII** — the six em dashes became `-` — so every code
  page decodes it identically;
* the file carries a **UTF-8 BOM**, which is what Microsoft recommends for 5.1
  compatibility, so it decodes as UTF-8 even if a non-ASCII character returns.

Both, because a BOM can be stripped in transit and a future edit can paste in a
smart quote. The script's own header now says so.

### Validation before publishing

`tests/source/19-diagnostic-script.mjs` — 38 assertions in the `source` block:
BOM present, body pure ASCII, each specific trap character named (em/en dash,
smart quotes, ellipsis, non-breaking space), delimiters balanced outside strings
and comments, nothing that needs PowerShell 7 (`??`, `?.`, `&&`, ternary,
`$PSStyle`, `-Parallel`), and the real
`[System.Management.Automation.Language.Parser]` run twice — once on the UTF-8
decode and once on the bytes reinterpreted as a single-byte code page, which is
the run that would have caught this.

It also asserts what the diagnostic must never do, since it runs elevated on a
test machine: no UAC policy change, no Defender change, no self-elevation, no
service start/stop, no registry write, no `Set-ExecutionPolicy`, no network call,
no credential read, no keystroke capture. The one deletion it performs is its own
`hda-*.log` files behind `-Clear`, and that shape is asserted rather than
deletion being banned outright.

Mutation-tested: the committed broken file, a BOM-stripped copy, and a pasted
smart quote each turn the block red.

`scripts/publish-diagnostics.sh` runs that validation and a secret scan before
copying the file into the public download directory, and refuses to publish if
either fails. This is the only artefact this project publishes as readable text.

### Published

| | |
|---|---|
| URL | `https://sarah-wanted-councils-lewis.trycloudflare.com/download/mt06-diagnostics.ps1` |
| SHA-256 | `4e66d32e243c31b2ecea42995aab62ff850e20f6b746efdb2fcde92267891db5` |
| Size | 12,257 bytes |

Verified through the live tunnel: the served bytes hash identically, the BOM
survives the transfer, and the served file parses with 0 errors when decoded the
way 5.1 would. The Cloudflare tunnel was not restarted and `HelpdeskAnywhere.exe`
was not rebuilt. Regression 24 blocks / 436 assertions / 0 failures.

---

## Transport — ngrok out of bandwidth, replaced with a Cloudflare quick tunnel — 2026-09-05

Status: LINUX INTEGRATION VERIFIED · deployment verification 16/16 through the new
tunnel · regression 23 blocks / 397 assertions, 0 failures · audit 5/5 ·
**MT-01 and MT-06 unblocked and awaiting the user's Windows retest**

### Why

ngrok began returning HTTP 403 `ERR_NGROK_725` — the account had reached its
monthly network bandwidth limit. That blocked both outstanding Windows manual tests
outright rather than inconveniently: the applet download and the session's own
WebSocket traffic cross the same tunnel, so with it capped there was no way to run
MT-01 or MT-06 at all. Restarting does not help; the cap is monthly and
account-wide.

The cap was always a poor fit for this tool. The applet is a 66 MB self-contained
binary, downloaded fresh for every test, and every screen frame of every session
goes through the same tunnel at 8-10 FPS.

### What changed

A `cloudflared` compose profile running a Cloudflare quick tunnel, and
`scripts/deploy-cloudflared.sh` wrapping it — mirroring `deploy-ngrok.sh` exactly:
the same refusal to start with an open console, the same `PUBLIC_HOST`
reconciliation once the hostname exists, the same applet rebuild against the new
endpoint, the same verification pass. It stops the ngrok tunnel first, because two
tunnels means two public hostnames for one `PUBLIC_HOST` and the `/ws` Origin
policy accepts one.

No account, no token, no DNS, no cap — and one fewer secret in `.env` than the
ngrok path needed. Recorded as `DECISIONS.md` D-011, which amends D-007's choice of
stopgap without moving its destination.

The ngrok profile is kept, not deleted. Nothing about the `app` service differs
between the three transports, which is what D-007 designed for.

### Verified, not assumed

`verify-deployment.sh` through the tunnel: **16/16**, including a valid TLS
certificate, the `/ws` 101 upgrade, and a foreign browser Origin refused with 403.
A 66 MB `.exe` downloaded over it hashes identically to the file on disk. The
rebuilt binary carries the correct baked endpoint (`wss://sarah-wanted-councils-lewis.trycloudflare.com/ws`) and MT-01's
manifest fix is still intact in it.

### The catch, written down because it will bite

**The hostname is random and a new one is issued on every restart of the tunnel** —
exactly ngrok's free-tier weakness. The applet dials a URL baked in at build time
(PLAN 2.2), so a restarted tunnel silently orphans every `.exe` already downloaded:
it starts and then never connects. `restart: unless-stopped` is still correct — an
unreachable tunnel is worse than a changed one — and the deploy script is
re-runnable and reconciles `PUBLIC_HOST` and the `.exe` together.

This is still a stopgap. D-007's destination has not moved: DuckDNS + Caddy, a
stable hostname and a Let's Encrypt certificate, which needs a subdomain, a token,
and ports 80/443 open on the VM.

### Live

| | |
|---|---|
| Console | `https://sarah-wanted-councils-lewis.trycloudflare.com/` |
| Download | `https://sarah-wanted-councils-lewis.trycloudflare.com/download/HelpdeskAnywhere.exe` |
| WSS | `wss://sarah-wanted-councils-lewis.trycloudflare.com/ws` |
| SHA-256 | `feb8e64cdd9e0e1be68c799f9cc1a5fa0ded6256edef141bc98923fbacb4543e` |
| Size | 65,913,220 bytes |

---

## MT-06 Secure Desktop — the watch ran where the answer does not exist — 2026-09-05

Status: FIX IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED ·
**WINDOWS RETEST REQUIRED** · MT-06 mode A remains FAILED until the user retests

### The failure

Recorded on real Windows. Elevation mode A ("user is an administrator — ask them
to approve") worked: the genuine UAC prompt for `HelpdeskAnywhere.exe` appeared,
the user clicked Yes, the desktop came back. Later, a TeamViewer launch raised a
second genuine UAC prompt. The Windows machine showed it correctly on the Secure
Desktop. **The technician canvas went black** — not frozen, black — and recovered
when the prompt closed.

### Root cause

`DesktopWatcher` polled `OpenInputDesktop` from inside the LocalSystem service,
which runs in **session 0**.

`OpenInputDesktop` resolves the input desktop of the window station associated
with the *calling process*, and window stations are per-session. A session-0
service is on `Service-0x0-3e7$`, which has no input desktop at all. So the
interactive session's switch to `Winlogon` was invisible from there — either the
call failed, in which case the caller's `desktop.Length > 0` guard meant **no
helper was ever launched at all**, or it returned the service window station's own
`Default`, in which case a helper was pinned to `WinSta0\Default` forever.

Both endings are the same ending: nothing ever captured the Winlogon desktop, the
applet was never told to pause, and `AppletContext.OnDesktopChanged` never fired.

The black is the second half, and it is the part worth remembering. A `BitBlt` of a
desktop that no longer owns the display **does not fail**. It succeeds and returns
black pixels. `GdiCapture.Grab` only returns `null` when `BitBlt` fails, so the
applet encoded a full black keyframe and sent it, ten times a second, and every
layer above treated that as a working stream — because by every signal it had, it
was one.

Neither half could be caught here: the code compiles, the API exists, the call is
spelled correctly, and it is simply being made in the one place where it cannot
answer.

**Failure stage: desktop detection.** Everything downstream — helper launch, frame
routing — failed as a consequence, not independently.

### Fix

* **`SecureDesktopService/SessionWatcher.cs` (new, `--desktop-watch`).** The watch
  now runs inside the interactive session, as SYSTEM on `WinSta0\Default`, where
  `OpenInputDesktop` has an answer. It keeps one helper alive on the current input
  desktop, launched with a plain `CreateProcess` and an `lpDesktop` — no token
  dance, because it is already SYSTEM in the right session.
* **`SecureDesktopService/DesktopWatcher.cs`** keeps the one job only session 0 can
  do — `SE_TCB_NAME` and moving a SYSTEM token across the session boundary — and
  becomes a supervisor: one watcher, restarted if it dies or the console session
  changes. PLAN 5.3's two documented failure modes now sit on a path that runs once
  per session instead of once per UAC prompt. Recorded as `DECISIONS.md` D-010.
* **`Applet/Capture/DesktopGuard.cs` (new).** Before capturing, ask whether this
  thread's desktop still owns the display; if not, skip the frame instead of
  sending a black one. Deliberately conservative — it suppresses only when it can
  positively establish that another desktop owns the display, because a guess that
  goes the wrong way would break ordinary screen sharing, which is a far worse
  failure than a black frame. Used unchanged by the applet and by the helper.
* **`Applet/Capture/StreamSource.cs` (new).** The handoff between two capturers is
  now an explicit four-state machine — `DefaultDesktop`,
  `SecureDesktopTransition`, `SecureDesktop`, `ReturningToDefault` — with a state
  for each *gap*, and in both gaps neither source sends. The old single "paused"
  flag was only ever set once a helper had already attached and announced itself;
  everything before that moment was the applet streaming black.
* **The applet watches for itself.** It runs in the interactive session too, so it
  polls the same question and starts the handoff when the Secure Desktop appears
  rather than when a helper finishes launching. **Even with the whole elevated
  chain broken, the canvas now freezes on the last true frame instead of going
  black.**
* **Elevation now means usable, not installed** (`ElevationManager.WaitUntilUsable`).
  Success is reported to the agent only once the service is RUNNING, has attached
  to the applet's pipe, and the session watcher has attached. A timeout names which
  of the three never became true. Previously `Process.Start` returning plus a
  service *registration* — which a previous session could have left behind — was
  enough to report "elevated".

### Diagnostics

`Shared/DiagLog.cs` and `Shared/DiagPaths.cs`: a timestamped, stage-tagged log
across all four processes. The elevated processes ship every line to the applet
over the pipe they already have, so one user-readable file holds the whole
chronology and survives the service's self-uninstall. Every failed Win32 call logs
the API, the number and what Windows calls it. Sessions and PIDs are logged at each
launch, so "the watcher landed in the wrong session" is one line rather than an
afternoon.

Never logged: credentials, keystrokes, script text, session codes (constraint #6),
asserted at the call sites by `tests/source/18-secure-desktop.mjs`.

`scripts/mt06-diagnostics.ps1` reads all of it and prints a stage-by-stage verdict —
service missing, service stopped, wrong session, helper missing, desktop not
detected, pipe disconnected, capture failing — so one retest is enough.

### Regression protection

`tests/source/18-secure-desktop.mjs` — 49 assertions, registered in the `source`
block. Among them: the session-0 service must never call `OpenInputDesktop`; every
`lpDesktop` assignment carries the window-station prefix; `Grab` consults the guard
before `BitBlt`; helper frames are dropped unless the state machine says so;
elevation waits for all three preconditions; the watcher is never treated as a
helper for input routing; no `DiagLog` call site passes a credential. Each was
mutation-tested: reintroducing the original defect, deleting the black-frame guard
and forwarding helper frames unconditionally each turn the block red.

### Not changed

UAC is not bypassed, the Secure Desktop is not weakened, nothing auto-clicks Yes,
and Ctrl+Alt+Del still goes to `SendSAS` rather than a synthesised chord. The
technician's own click remains the only source of a consent decision.

### Replacement binary

Clean rebuild against `wss://paternity-cannot-removal.ngrok-free.dev/ws`:

| | |
|---|---|
| Path | `server/public/download/HelpdeskAnywhere.exe` |
| Size | 65,913,228 bytes |
| SHA-256 | `267e819223d2f7180f91e32ae8c745eb5f94c2972576a3c109f4c4913ca6da49` |

Regression 23 blocks / 397 assertions / 0 failures. MT-01's manifest fix verified
still intact in the new binary. Application verified 14/14 directly against the
container.

### Blocker found while verifying — the tunnel is out of bandwidth

`https://paternity-cannot-removal.ngrok-free.dev` returns **HTTP 403
`ERR_NGROK_725` — "This ngrok account has reached its network bandwidth limit for
the month."** The Ubuntu stack is healthy and serving the new binary correctly
(verified directly against the container, 14/14); it is the ngrok edge refusing all
traffic, and a restart will not help — the cap is monthly and account-wide. Two
66 MB verification downloads over the tunnel this session contributed to it.

**MT-06 cannot be retested until the transport is restored**, because the session's
frames travel the same tunnel as the download. The unblock is the deployment
`CLAUDE.md` actually specifies and `DECISIONS.md` D-007 always intended: DuckDNS +
Caddy (`./scripts/deploy.sh`), which needs a DuckDNS subdomain and token and
ports 80/443 open on the VM. Recorded in `DEPLOYMENT.md`.

---

## MT-01 Windows startup — malformed embedded application manifest — 2026-09-05

Status: FIX IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED ·
**WINDOWS RETEST REQUIRED** · MT-01 remains FAILED until the user runs the
replacement binary

### The failure

The first real Windows execution of `HelpdeskAnywhere.exe` never reached `Main`:

> The application has failed to start because its side-by-side configuration is
> incorrect. Please see the application event log or use the command-line
> sxstrace.exe tool for more detail.

`sxstrace` reported `Line 2: XML Syntax error` while parsing the manifest embedded
in the executable, then `Activation Context generation failed`.

### Root cause — proven, not assumed

`windows/Applet/app.manifest` line 7 read:

```xml
    relaunches this exe with `--install-service`. Do not change this to
```

That is inside the XML comment opened on line 4, and **XML 1.0 section 2.5 forbids
the string `--` anywhere inside a comment**. The file was therefore not well-formed
XML. Confirmed against the shipped binary rather than the source: the RT_MANIFEST
resource was extracted from the 65,901,261-byte `.exe` at RVA `0x945830` and is
**byte-identical to the source file** (1,479 bytes, `diff` clean), and `expat`
rejects it at *line 7, column 32 — not well-formed (invalid token)*.

The reason it shipped is the part worth keeping: MSBuild's `<ApplicationManifest>`
**never parses the file**. It copies the bytes into the PE resource. So the defect
compiled cleanly on Ubuntu, passed all 21 test blocks, produced a valid PE32+ x64
image with a correctly-formed resource directory — and was rejected only by the one
parser nobody on this side of the wire can run, in the Windows loader, on the far
side of a 66 MB download and a manual test.

`sxstrace` says line 2 where `expat` says line 7; Microsoft's parser counts lines
from the first element rather than the file. The class of error, the failing
construct and the resulting activation failure all match exactly.

### Fix

- **`windows/Applet/app.manifest`** — the comment now names the switch without its
  leading hyphens, and carries a header explaining why no comment in that file may
  ever contain a double hyphen. The elevation architecture is untouched:
  `requestedExecutionLevel` stays `asInvoker`, because CLAUDE.md constraint #1 puts
  the consent dialog first and elevation is a separately-consented step (PLAN 5.2).
  Changing it to `requireAdministrator` would have made the `.exe` start and broken
  the design.
- An `<assemblyIdentity>` was added (`type="win32"`,
  `processorArchitecture="amd64"`, four-part version). Application manifests are
  legal without one, but a null identity is the first line `sxstrace` prints, and a
  real one keeps that from reading like the fault on the next trace.

### Regression protection

- **`tests/lib/manifest.mjs`** — a dependency-free strict XML scanner (double
  hyphen in a comment, unterminated comment, unquoted or duplicated attribute, bare
  `&`, raw `]]>`, mismatched or unclosed tags, stray XML declaration, undeclared
  namespace prefix, BOM, backslash-escape corruption from shell quoting) plus a PE
  resource-directory reader that pulls RT_MANIFEST back out of a built `.exe`.
- **`tests/source/17-manifest.mjs`** — 98 assertions in the `source` block. Checks
  the source XML, the manifest actually embedded in the built binary, and that the
  two are the same bytes. Every defect has a negative case proving the validator
  goes red, **including the real one replayed from `153e449`**.
- **`scripts/build-windows.sh`** — validates the source before `dotnet publish` and
  the embedded resource afterwards, before the binary is copied into
  `server/public/download/`. `set -e` makes either failure abort the build.

Checking the source alone would not have been enough: a later build step can
replace or damage the resource, and that resource is the only copy Windows reads.

### Other side-by-side dependencies — checked, none found

The PE imports only in-box Windows DLLs (`KERNEL32`, `USER32`, `ADVAPI32`,
`OLE32`, `OLEAUT32`, `SHELL32`, delay-loaded `VERSION`) and the UCRT
`api-ms-win-crt-*` API sets, which ship with Windows 10 and 11. The manifest
declares no `<dependentAssembly>`, so nothing has to be installed side by side.
**No VC++ redistributable is required**, and none should be suggested. Machine
type is `0x8664` against a `win-x64` publish, and DECISIONS D-009 means one binary
ships, so there is no second executable with a manifest of its own.

### Replacement binary

Clean rebuild (`bin/`, `obj/` and the old `.exe` removed first) against the live
tunnel, `wss://paternity-cannot-removal.ngrok-free.dev/ws`:

| | |
|---|---|
| Path | `server/public/download/HelpdeskAnywhere.exe` |
| Size | 65,903,057 bytes |
| SHA-256 | `20947ecbaa046532c74bb9a6bb3f6148e6ba3b1c534dfb3819410c1bff7f4968` |
| Embedded manifest | 2,941 bytes, byte-identical to source, validates clean |

Verified over the public URL, not assumed: the served bytes hash to the same
value, with a new `etag` and `last-modified`. `cache-control: public, max-age=0`
already forces revalidation on every request, so no stale binary can come back and
no unrelated control needed weakening.

Regression 22 blocks / 0 failures · deployment verification 16/16 against the live
tunnel · audit 5/5.

**MT-01 is not passed.** A Linux build proves the manifest is now well-formed; only
the Windows machine can prove the applet starts.

---

## Redeployment verification — 2026-09-05

Status: LINUX INTEGRATION VERIFIED · deployment verification 16/16 against the
live tunnel · regression 21 blocks / 277 assertions, 0 failures · TLS path 9/9 ·
audit 5/5 · `npm audit --omit=dev` 0 vulnerabilities · MT-01…MT-06 still MANUAL
ACCEPTANCE PENDING

A full build → test → verify pass over the deployment that has been up since
2026-09-04. **No application code changed.** The tunnel, the hostname and the
console credential are all unchanged, so the applet already in
`server/public/download/` was rebuilt against the same URL rather than a new one.

Verified rather than assumed: the served `.exe` is byte-identical to the one
built here (sha256 match over the public URL, 65,901,261 bytes, `MZ` header), and
the baked endpoint is `wss://paternity-cannot-removal.ngrok-free.dev/ws` — read
off the intermediate assembly's `AssemblyMetadata`, because
`EnableCompressionInSingleFile` hides it from `strings` on the bundle itself.

Two operational findings, both in `DEV_NOTES.md` → "Redeployment verification":

- **`verify-tls-local.sh` takes down a live deployment.** It shares the
  `helpdeskanywhere` compose project name, so its cleanup removed the running
  `app` container and the tunnel answered 502 until it was brought back. The
  ngrok container is untouched, so the URL survives. Now warned about in
  `DEPLOYMENT.md` § 4.
- **Two stale limitations in `DEPLOYMENT.md`.** "No Content-Security-Policy yet"
  outlived the CSP that shipped in `5a15af3`, and "`npm audit` cannot run in this
  environment (no registry access)" outlived the registry becoming reachable. Both
  corrected; a drifted check count (10 → 16) with them.

---

## First external deployment, behind ngrok — 2026-09-04

Status: LINUX INTEGRATION VERIFIED · deployment verification 16/16 against the
live tunnel · regression suite 21 blocks, 0 failures · TLS path 9/9 · audit 5/5
· MT-05 still MANUAL ACCEPTANCE PENDING (it needs the Windows machine)

The stack went up at `https://paternity-cannot-removal.ngrok-free.dev` and
`verify-deployment.sh` reported 14 passed, 2 failed. Both failures were in the
harness. A third problem, which nothing was checking, was real. Full reasoning in
`DEV_NOTES.md` → "First external deployment".

### Fixed

- **`verify-deployment.sh` now forces `--http1.1` on the two WebSocket checks.**
  Not a workaround: `Connection` and `Upgrade` are hop-by-hop headers that HTTP/2
  forbids (RFC 9113 §8.2.2), so when curl negotiated h2 by ALPN with ngrok's edge
  it dropped them and sent a bare `GET /ws`. That is not an upgrade, so `ws` never
  saw it, so it fell through to `consoleAuth` — hence `HTTP/2 401` where 101 was
  expected, and the same 401 where 403 was expected, because with no upgrade there
  is no `verifyClient` call and nothing ever looked at the Origin. Every real
  client here speaks HTTP/1.1 for the handshake: browsers do, and so does the
  applet's `ClientWebSocket`. `verify-tls-local.sh` already did this against
  Caddy. **No application check was weakened** — verified against the live tunnel:
  no Origin → 101, same-origin → 101, foreign origin → 403 `Forbidden origin`.

- **`PUBLIC_HOST` was still `localhost:8080` while the deployment was public.**
  The app must start before the tunnel it will be reached through exists, so it
  starts with whatever `.env` says, and with no reserved `NGROK_URL` that is
  necessarily stale. `deploy-ngrok.sh` now writes the discovered hostname back and
  restarts the app before verifying. Not cosmetic: `PUBLIC_HOST` is the URL
  `build-windows.sh` bakes into the `.exe` when `SERVER_URL` is not passed — an
  applet quietly dialling `wss://localhost:8080/ws` on the end user's machine — as
  well as one of the two hosts `originAllowed()` accepts and half of the
  `looksPublic` test that makes `ALLOW_INSECURE_DEV` fatal on a real deployment.
  The console was never affected: `portal.js` builds the join link and the `/ws`
  URL from `location`, never from server config.

### Added

- **`GET /ws` without an upgrade now answers 426 Upgrade Required**, ahead of
  `consoleAuth`, with an `Upgrade: websocket` header. The old 401 was a true
  refusal reported as the wrong kind of refusal, and it cost an hour of reading
  authentication code that was working correctly. Not a relaxation — a non-upgrade
  GET never reached the relay either way — and it discloses nothing, since `/ws` is
  already named in `portal.js`, in the join page's CSP `connect-src`, and in the
  URL baked into every applet. The deployment check reads a 426 back as "the proxy
  stripped Connection/Upgrade" rather than a bare failure.

- **`set_env` in `scripts/lib/envfile.sh`** — writes one key into `.env` in place,
  through a temp file created `600` in the same directory, so a file holding the
  console password and the ngrok authtoken is never briefly world-readable and
  never briefly truncated.

### Verified

- The `.exe` in `server/public/download/` is baked with
  `wss://paternity-cannot-removal.ngrok-free.dev/ws`, confirmed in the Release
  assembly metadata. With `PUBLIC_HOST` corrected, `build-windows.sh` now derives
  that same URL with no `SERVER_URL` argument at all.
- No secret in the tree, in the audit log or in the container logs: the console
  password and the ngrok authtoken both scan clean, and `.env` remains untracked.

---

## Hardening — CSP and dependency advisories — 2026-09-04

Status: AUTOMATED TEST VERIFIED (21 blocks, 270+ checks) · deployment
re-verified in Docker (14 + 5) · TLS path re-verified (9)

The two remaining cross-cutting tasks, both open only because this VM had no
registry access until GitHub authentication was configured.

### Fixed

- **Three moderate `qs` advisories** (GHSA-x5fp-wj9c-mxmx, array-limit bypass via
  bracket-key comma parsing; GHSA-4mjr-xmp4-gh2g, denial of service via
  attacker-controlled `isBuffer`). Reachable rather than theoretical: express
  parses a query string on every request, and Phase 7 puts the join endpoint on
  the public internet unauthenticated. Express 4.22.2 and body-parser 1.20.6 both
  declare `~6.15.1`, which stops short of the 6.16.0 fix, so this is an
  `overrides` entry — not a version bump, which would have done nothing. Express 5
  was the alternative: a major upgrade of the dependency the whole relay sits on,
  to fix a transitive one. `npm audit` now reports 0 vulnerabilities.

### Added

- **A Content-Security-Policy**, previously deferred as needing a nonce. It did
  not need one. The join page's inline script was pure client-side — it reads the
  session code out of `location.pathname` and writes it with `textContent` — so
  moving it to `/join.js` makes `script-src 'self'` sufficient, and avoids
  templating an otherwise static file on every request. `style-src` keeps
  `'unsafe-inline'`: the join page's inline `<style>` is deliberate (PLAN 1.5 — a
  self-contained page for a stressed non-technical reader), a style hash would
  break silently on any CSS edit, and no attacker-controlled string reaches that
  markup anyway. Everything else is denied: `object-src`, `base-uri`,
  `form-action` and `frame-ancestors` are all `'none'`.

- **`tests/browser/16-csp.mjs`** — 22 checks. The point of a separate block is
  that a CSP failure is not a page error: the browser blocks the resource, logs
  where nothing is listening, and renders a page that looks nearly right. So it
  registers a `securitypolicyviolation` listener *before* navigation, asserts the
  count is zero, and then asserts the scripts actually did their work. It also
  settles empirically that `connect-src 'self'` admits the same-origin `/ws`
  upgrade. Verified to fail when the invariant is broken — restoring the inline
  script produces `script-src-elem blocked inline` — not merely to pass.

- **Two deployment checks** in `verify-deployment.sh`, because the app setting a
  header and the deployment sending it are different claims, and a reverse proxy
  is perfectly capable of dropping one in between.

---

## Cross-phase review — 2026-09-04

Status: AUTOMATED TEST VERIFIED (20 blocks, 250+ checks) · deployment
re-verified in Docker (12 + 5) · the TLS path verified locally for the first
time (9)

A review of phases 1–7 after Phase 5 landed, on the principle that code which
builds is not thereby correct. Seven findings, none of them in Phase 5 itself.

### Fixed

- **Teardown stopped capture last, not first.** Both teardown paths said "no
  frame may outlive the session" in a comment and then disposed the streamer
  fourth — after an SCM stop-and-wait and a process-tree kill. The user's screen
  kept going out over an open socket for the whole of that, after they had
  clicked End Session. Both paths now run in the order of the promises: stop
  sending pixels, release held keys and buttons, kill what the agent started,
  remove the elevated service.
- **A cross-thread race could abort teardown.** `InputInjector`'s held-key set is
  mutated from the UI thread and read from `Program.Teardown`, which runs on
  whatever thread crashed. A `HashSet` mutated from two threads can throw — and
  every teardown step was a bare statement, so a throw in step two meant the
  step that removes a LocalSystem service never ran. The state is now locked and
  every step is independently guarded.
- **SYSTEM scripts did not stream.** `ScriptRunner` flushes output every 250 ms;
  the elevated service's copy sent nothing until the process exited, so an
  `asSystem` script showed a blank pane for up to the full two-minute timeout.
- **`ALLOW_INSECURE_DEV` was only a warning.** It disables the check that keeps
  an administrator password off a plaintext wire. Now fatal on anything that
  looks like a real deployment.
- **Three settings could not be set at all.** `CREATE_ATTEMPTS_PER_MINUTE`,
  `MAX_LIVE_SESSIONS` and `ALLOWED_ORIGINS` were absent from compose's explicit
  environment block, so they were pinned to their defaults in every deployment.
- **`deploy.sh` had no console-password check** while `deploy-ngrok.sh` refused
  without one — and the TLS path is the more exposed of the two.
- **A placeholder passed for a secret.** Both deploy scripts checked only for
  emptiness, so an unedited `.env` started a stack that failed obscurely later.

### Added

- `input.sas` audit event. Ordinary mouse and key events are far too many to
  record, but the Secure Attention Sequence is reachable only after elevation and
  is the agent reaching the Windows security screen (constraint #5).
- `scripts/verify-tls-local.sh` — 9 checks against the real Caddy service and the
  real `Caddyfile`, using Caddy's internal CA. The permanent deployment path had
  never been exercised because it looked like it needed a DuckDNS token.
- `scripts/dev-local.sh` — the local stack as one command, with the
  `HOST_UID`/`HOST_GID` export that a hand-run compose silently needs.
- `build-windows.sh --server https://…`, converting the scheme and appending
  `/ws`, so an operator copies a printed URL instead of translating one.
- `scripts/lib/envfile.sh` — the `read_env`/`harden_env` pair that had been
  copied into three scripts, plus `looks_placeholder`.

---

## Phase 5 — UAC / Secure Desktop — 2026-09-04

Status: IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED where Linux can
reach (browser 24 checks, `ElevationErrorTests` 9, source invariants 25) ·
**WINDOWS MANUAL ACCEPTANCE PENDING — MT-06**

Nothing in this entry has executed on Windows. It cross-compiles; that is all a
Linux machine can say about it.

### Added

- **Elevation, both modes** (`PLAN.md` 5.2). Mode A relaunches the applet with the
  `runas` verb and Windows shows its own consent prompt; mode B uses
  `CreateProcessWithLogonW` so **no prompt appears on the end user's screen at
  all** — the case that matters on a managed fleet, where the user is not an
  administrator and must never be shown the admin password.
- **LocalSystem service + per-desktop helper** (5.3, 5.4). The service polls
  `OpenInputDesktop`, duplicates its own SYSTEM token into the console session and
  launches a helper bound to `WinSta0\Winlogon`, which captures and injects there
  with the same `GdiCapture`/`ScreenStreamer`/`InputInjector` the applet uses.
- **Named-pipe bridge** (5.5), ACL'd to LocalSystem and the session's user, carrying
  helper frames verbatim in the same `[0x01]`/`[0x02]` framing as the WebSocket.
- **`agent.input { kind:"sas" }`** (4.3) — Ctrl+Alt+Del as its own message, because
  no `SendInput` sequence can produce a Secure Attention Sequence. The console's
  button unlocks only after `host.elevated { ok:true }`.
- **`asSystem` scripts** now reach the elevated service instead of being refused.
- Console elevation panel: mode selector, credential fields cleared the instant they
  are sent, mapped error messages, "UAC prompt active" banner.
- One binary, three entry points (`DECISIONS.md` D-009) — the alternative was a
  ~160 MB download for a non-technical caller.

### Fixed during the Phase 5 review

- **The watchdog could never fire.** `PipeChannel.Exists` opened `\.\pipe` — a
  drive-relative path — instead of `\\.\pipe\`. It threw on every call, and a throw
  is read as "the applet is still there", so the backstop that guarantees constraint
  #4 when the applet is killed was dead code. Now correct, with a source-invariant
  test, and backed by a 12-hour absolute ceiling for the case where the check itself
  is unusable.
- **The staging directory inherited `%ProgramData%` permissions**, where any user may
  create subdirectories and `CREATOR OWNER` inherits full control — so a standard
  user could pre-create `%ProgramData%\HelpdeskAnywhere\`, own it, and replace the
  binary about to be registered as a LocalSystem service. It is now removed if
  present and re-created with a protected DACL (LocalSystem + Administrators).
- **A successful elevation could be reported as a failure.** The installer child is
  short-lived and `Process.GetProcessById` threw when it had already exited; the wait
  is now on the handle `CreateProcess` returned.
- **`lpCommandLine` was marshalled as a `string`.** The CreateProcess family may write
  to that buffer, and a Unicode `string` parameter is pinned rather than copied — so
  the callee was handed a pointer into the .NET string heap. Now `StringBuilder`.
- **A retried elevation could never connect.** A failed attempt disposed the pipe
  listener while keeping the manager, so the next attempt installed a service with
  nothing to talk to.
- The token was duplicated at `SecurityIdentification`; a primary token for
  `CreateProcessAsUser` wants `SecurityImpersonation`, and the wrong one is one of the
  two documented ways to get error 5 out of this sequence.
- Concurrent `asSystem` results could interleave their frames on the shared pipe.
- The indicator claimed "the agent ran a script as SYSTEM" even when the script had
  been refused for lack of elevation.
- Session end no longer waits on the 60-second watchdog: the applet asks the service
  to remove itself over the pipe, because it cannot delete a LocalSystem service
  itself.
- One elevation at a time, so a double-click cannot race two installers.

### Added — tests

- `tests/browser/14-phase5-elevation.mjs` (24 checks) — panel lifecycle, the password
  cleared on send and absent from `localStorage`/`sessionStorage`/the DOM, SAS as a
  message rather than a chord, the desktop banner.
- `tests/dotnet/ElevationErrorTests` (9 checks) — Win32 code → an actionable sentence.
- `tests/source/15-windows-invariants.mjs` (25 checks) — the properties a compiler
  cannot see and Linux cannot execute: no auto-start service, a pipe path that
  resolves, a password that reaches no log, a DACL that is not inherited.

---

## Security review — 2026-09-03

Status: AUTOMATED TEST VERIFIED (17 blocks, ~220 checks) · deployment
re-verified in Docker (12 checks) · `DEV_NOTES.md` → "Security review" carries
the full write-up

### Fixed

- **Console authentication could be walked around with path traversal.**
  `/download/../portal.html` and `/j/../portal.js` served the agent console with
  no credentials: the auth check matched the raw path against the routes the end
  user must reach openly, while `express.static` resolved the dots. The check now
  runs on a percent-decoded, normalised path.
- **The `/ws` upgrade accepted any browser Origin** — cross-site WebSocket
  hijacking. A foreign Origin is now refused with 403, while a client that sends
  no Origin at all (the applet, and every non-browser client) is still accepted.
- **`agent.create` had no rate limit and no ceiling.** Every create burns a code
  and writes an audit record, and with `CONSOLE_PASSWORD` unset anyone can reach
  it. Now `CREATE_ATTEMPTS_PER_MINUTE` (10/IP) and `MAX_LIVE_SESSIONS` (500).
- **A wire-supplied exec id chose the staged script's path.** `Path.Combine`
  discards its first argument when the second is rooted, so an id of
  `C:\Windows\Temp\x` — or `..\..\Startup\x` — staged and ran the script
  outside the session folder that teardown deletes, defeating constraint #4.
  `ScriptStaging.SafeFileName()` now confines it.
- The control-frame size cap counted UTF-16 units rather than bytes.
- Both deploy scripts chmod the `.env` to 600; it holds the console password and
  the ngrok authtoken and was world-readable.
- `docker-compose.local.yml`'s documented command omitted `HOST_UID`/`HOST_GID`,
  so a hand-run stack restart-looped on the audit-writable guard on any machine
  whose uid is not 1000.

### Added

- `tests/ws/07-security.mjs` — 14 regressions for the four defects above.
- `tests/dotnet/StagingTests` — 17 cases for the exec-id confinement.
- Two new checks in `scripts/verify-deployment.sh`: the traversal bypass is
  closed, and a foreign Origin is refused, both asserted against a live
  deployment.

---

## Regression suite promoted into the repo — 2026-09-03

Status: AUTOMATED TEST VERIFIED (15 blocks, ~190 checks, green in both the
unauthenticated and `CONSOLE_PASSWORD` configurations)

### Added

- `tests/` — every harness written during phases 1–6 now lives in the repo
  instead of a session scratchpad. Six protocol suites over raw WebSockets, four
  headless-Chrome suites driving the real console, and four `net8.0` unit suites
  that link the dependency-free C# classes (`AppletConfig`, `Protocol`,
  `TileGrid`, `KeyMap`) straight out of `windows/`.
- `tests/run-all.sh` (and `scripts/run-tests.sh`) — one runner, `--only ws |
  browser | dotnet` and `--no-browser`. Each block gets a **fresh server**,
  because the per-IP rate limiter and the code TTL are process state.
- `tests/setup-browser.sh` — installs Chrome for Testing and Puppeteer into
  `~/.cache/helpdesk-anywhere`, working around the two Ubuntu 24.04 snags
  recorded in `DEV_NOTES.md`. Neither is a dependency of the product, so neither
  is in `server/package.json` or the tree; the browser blocks **skip with a
  warning** when they are absent rather than failing the run.
- `tests/README.md` — a per-block table of what each suite actually proves.

### Changed

- The suites take their port, audit directory and server log from the
  environment (`HDA_TEST_PORT`, default 8099) instead of hard-coded `/tmp` paths
  and port 8080, so a run cannot disturb a dev server or the container.

### Why

The harnesses proved every Linux-side phase, then lived only in `/tmp` — one
reboot from being gone, and unrunnable by a fresh session. Nothing that guards
the six constraints should be that fragile.

---

## Phase 7 — Package, deploy, external access — 2026-09-03

Status: IMPLEMENTED · BUILD VERIFIED · LINUX INTEGRATION VERIFIED (the full stack
runs in Docker and the whole browser regression suite passes against it) ·
EXTERNAL ACCESS PENDING the user's ngrok token (`MANUAL_TESTS.md` → MT-05)

### Added

- Two interchangeable compose profiles over one identical `app` service: `ngrok`
  (temporary, no DNS) and `tls` (DuckDNS + Caddy). Migration is configuration only.
- `scripts/deploy-ngrok.sh` — build, start, wait for the tunnel, rebuild the applet
  against that URL, verify, and print the URLs.
- `scripts/verify-deployment.sh` — 10 checks incl. the `/ws` upgrade through the
  proxy and that the download really is a Windows binary.
- `scripts/verify-audit.sh` — audit integrity plus the constraint #6 scan for any
  credential-shaped field.
- `server/src/auth.ts` — shared-credential console authentication covering both the
  console page and its WebSocket (D-008).
- Security headers (nosniff, no-referrer, frame-deny), log rotation, service
  healthchecks and dependency ordering, `docker-compose.local.yml` for loopback
  smoke tests, and `DEPLOYMENT.md`.

### Fixed

- **The audit log silently failed in Docker.** The container ran as uid 1000 while
  the bind-mounted `./audit` belonged to another uid, so every write hit EACCES and
  left one line on stderr — constraint #5 broken in the deployed configuration.
  The container now runs as the directory's owner, and the server **refuses to
  start** if the audit log is not writable.
- `deploy.sh` and `verify-deployment.sh` no longer `source .env`: a `.env` is data,
  and sourcing executes any value containing a space or a backtick.

- `README.md`, `server/.dockerignore`, and a transient (auto-reverting) session
  indicator notice per PLAN 6.3.

### Verified

- 10 deployment checks, 5 audit checks, and the Phase 3/4/6 browser suites
  (19 + 20 + 21) re-run **against the containerised stack with console auth on**.
- Crash/restart behaviour, container health, and boot-time recovery.

---

## Phase 6 — Remote script execution — 2026-09-03

Status: IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED (console, streaming
protocol, audit guardrails) · WINDOWS MANUAL ACCEPTANCE PENDING
(`MANUAL_TESTS.md` → MT-04)

### Added

- `Scripting/ScriptRunner.cs` — stages the script to a per-session temp folder, runs
  PowerShell or cmd with both streams read asynchronously, flushes output every
  250ms, enforces a 120s timeout and a 1 MB output cap, and kills the whole process
  tree on timeout or session end.
- Console script pane: shell selector, Run-as-SYSTEM checkbox, streaming output with
  exit code, and a per-session run history.

### Changed — protocol (all three mirrors together)

- `host.execResult` gained an optional `partial` flag distinguishing a streamed chunk
  from the final result. `signaling.ts` now audits only the final one.

### Verified

- 21 checks: consent gating, frame shape, incremental rendering, exit-code handling,
  run history, markup-injection guard, and the two audit guarantees — full script
  text recorded *before* execution, exactly one `exec.result` per run.
- Phase 3 (19) and Phase 4 (20) harnesses re-run green after the console changes.

---

## Phase 4 — Remote input injection — 2026-09-03

Status: IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED (browser capture,
coordinate mapping, key table) · WINDOWS MANUAL ACCEPTANCE PENDING
(`MANUAL_TESTS.md` → MT-03)

### Added

- `Interop/Input.cs` — `SendInput`, `INPUT`/`MOUSEINPUT`/`KEYBDINPUT`, `MapVirtualKey`.
- `Input/KeyMap.cs` — DOM `event.code` → Windows VK, extended-key set, modifier set.
- `Input/InputInjector.cs` — absolute mouse positioning normalised to the 0–65535
  virtual-desktop space, scancode-based keyboard injection, and release-everything
  cleanup on session end, peer drop and crash.
- `portal.js` — mouse/key capture on the canvas, backing-store coordinate mapping,
  60/s move throttle, wheel sign inversion, blur release of held keys.
- `portal.html` — focusable canvas and the special-key buttons (Win, Alt+Tab,
  Ctrl+Esc, PrtScn, Ctrl+Shift+Esc), with Ctrl+Alt+Del disabled until Phase 5.

### Fixed

- A window-level `mouseup` sent a stray click into the user's desktop whenever the
  agent clicked any console button. Found by the new harness.

### Verified

- Browser input capture end-to-end — 20 checks, including that a centre click on a
  1600x900 remote shown in a 998px canvas maps to x=800 and not to the CSS x=499.
- `KeyMap` — 12 checks.

---

## Phase 3 — Screen capture + streaming — 2026-09-03

Status: IMPLEMENTED · BUILD VERIFIED · AUTOMATED TEST VERIFIED (renderer, tile
coalescing) · WINDOWS MANUAL ACCEPTANCE PENDING (`MANUAL_TESTS.md` → MT-02)

### Added

- `Interop/Gdi32.cs`, `Interop/User32.cs` — P/Invoke for capture, isolated in
  `Interop/` per the project conventions.
- `Capture/IScreenCapture.cs` — abstraction carrying the virtual-screen origin as
  well as its size, which Phase 4 input mapping needs.
- `Capture/GdiCapture.cs` — `BitBlt` capture with reused DC/bitmap handles, manual
  cursor compositing, and surface rebuild on a resolution or monitor change.
- `Capture/TileGrid.cs` — dirty-rect tile arithmetic, dependency-free so it is
  testable on Linux.
- `Capture/ScreenStreamer.cs` — 10 FPS capture→encode→send loop on its own thread,
  JPEG q60, FNV-1a tile diffing, 5-second keyframes, backpressure by skipping
  capture, and failure degradation.
- `portal.js` — canvas renderer for `[0x01]`/`[0x02]` frames with ordered async
  decode, plus the FPS/kbps counter.

### Verified

- Renderer end-to-end in headless Chrome against the real relay — 19 checks.
- `TileGrid` coalescing — 12 cases including a 200-grid random invariant.
- `dotnet build` — 0 warnings, 0 errors; publish produces a valid PE32+ .exe.

---

## Phase 2 — Windows applet: connect, code entry, consent — 2026-09-03

Status: IMPLEMENTED · BUILD VERIFIED · LINUX INTEGRATION VERIFIED ·
WINDOWS MANUAL ACCEPTANCE PENDING (`MANUAL_TESTS.md` → MT-01)

### Added

- `AppletConfig` — server URL baked in at publish time via `AssemblyMetadata`, URL
  normalisation (bare host → `wss:`), six-digit code validation.
- `SessionClient` — `ClientWebSocket` transport, dispatch loop, separate control and
  frame send queues, connect backoff, idempotent close.
- `AppletContext` — the code entry → consent → indicator → teardown flow.
- `CodeEntryForm`, `ConsentForm`, `IndicatorForm` (constraints #1, #2, #3).
- Global teardown wiring: process exit, unhandled exception, `Ctrl+C`,
  `SessionEnding`, `WM_QUERYENDSESSION`.
- Project memory: `PROGRESS.md`, `TASKS.md`, `MANUAL_TESTS.md`, `ARCHITECTURE.md`,
  `DECISIONS.md`, `CHANGELOG.md`.

### Changed

- `scripts/build-windows.sh` derives and bakes the server URL from
  `SERVER_URL` / `PUBLIC_HOST`.
- `Applet.csproj` — `ServerUrl` property, `AssemblyMetadata`, PerMonitorV2 DPI.

### Verified

- `dotnet build windows/HelpdeskAnywhere.sln -c Release` — 0 warnings, 0 errors.
- `AppletConfig` parsing — 22 cases pass (linked into a Linux `net8.0` harness).
- Applet wire frames replayed verbatim against the live relay — 12 checks pass.
- `npm --prefix server run typecheck` — clean.

---

## Phase 1 — Server: sessions, pairing, portal — 2026-09-02  (`744cb7f`)

Status: AUTOMATED TEST VERIFIED (71 checks, headless Chrome two-tab flow)

Session store with single-use 6-digit codes and TTL, WSS signaling and verbatim
relay with a consent gate, agent console, join page, JSONL audit log, and the
credential-elevation transport guard brought forward from Phase 5.

---

## Phase 0 — Environment + scaffold — 2026-09-02  (`b841323`)

Status: BUILD VERIFIED

Ubuntu toolchain (Node 22, Microsoft .NET 8 SDK, Docker), project scaffold, and proof
that `dotnet publish -r win-x64` produces a real `PE32+ executable (GUI) x86-64` from
Linux.
