# Helpdesk Anywhere — Decision Log

Significant decisions and their reasoning. Settled decisions are not reopened without
new evidence. Design decisions that belong to the original specification live in
`CLAUDE.md`; this file records decisions made *during* implementation.

---

## D-001 — `PLAN.md` and `CLAUDE.md` are immutable

Date: 2026-09-02

### Problem

`CLAUDE.md` says to update `PLAN.md`'s checkboxes as work lands, but the plan is also
the contract being built against.

### Options

1. Update the checkboxes in `PLAN.md` as work lands.
2. Freeze both specs; track status in separate files.

### Decision

Option 2. Neither file is edited. Status lives in `PROGRESS.md` / `TASKS.md`;
findings and deviations go to `DEV_NOTES.md` and this file.

### Reason

Letting the implementation rewrite its own spec erases the record of what was
promised versus what was discovered.

### Trade-offs

`CLAUDE.md`'s checkbox instruction is knowingly not followed. The conflict is flagged
here rather than resolved silently.

---

## D-002 — A pending Windows manual test does not block later phases

Date: 2026-09-03

### Problem

`CLAUDE.md` and `PLAN.md` state: "Do not start phase N+1 until phase N's test passes
on real hardware." Phase 2's acceptance requires a human on a Windows machine. Under
a strict reading, all development stops until that human is available — which had
already halted the project once.

### Options

1. Keep the hard gate; stop until the user runs each Windows test.
2. Drop acceptance testing.
3. Do every validation the environment allows, record the untested behaviour as a
   pending manual test, and continue with independent work.

### Decision

Option 3, on the user's explicit instruction (2026-09-03).

### Reason

The gate exists to stop *unverified work being declared done*, not to serialise all
development behind human availability. Phase 3 capture code does not depend on the
*result* of the Phase 2 UI test — only on its interfaces. The protection is preserved
by never marking a manual test PASSED without the user, and by tracking every one in
`MANUAL_TESTS.md`.

### Trade-offs

Real risk: a Phase 2 defect found later may invalidate Phase 3 work built on top of
it. Accepted deliberately, and bounded by keeping Phase 3 behind the same interfaces
Phase 2 already exercises. This is a documented deviation from `CLAUDE.md`, made on
explicit user authority, per the precedence order the user set (explicit user
requirements rank above `CLAUDE.md`).

---

## D-003 — GitHub remote is not configured on this VM

Date: 2026-09-03

### Problem

The workflow requires pushing every stable checkpoint to
`https://github.com/manojastro/helpdesk-anywhere-claude-Linux.git`. This VM has no
`origin` remote, no `gh` CLI, no git credential helper and no SSH private key.
`git remote add` is additionally denied by the sandbox permission classifier.

### Options

1. Stop all work until the remote exists.
2. Work locally, commit every checkpoint, and let the user attach the remote later.
3. Attempt to work around the permission denial.

### Decision

Option 2. Option 3 is out of bounds — the denial is a deliberate control on
outward-facing actions, and there are no credentials to authenticate with regardless.

### Reason

Commits are the durable artefact; the push is a transport step that can happen at any
time, and every local commit pushes cleanly once a remote and credentials exist.
Blocking development on it would repeat exactly the failure mode D-002 fixes.

### Trade-offs

Until the user attaches the remote, the work exists only on this VM — which is the
session-recovery risk the workflow is trying to eliminate. Flagged prominently in
`PROGRESS.md` → Blockers.

---

## D-004 — The applet's server URL is compiled in

Date: 2026-09-03

### Problem

`PLAN.md` 2.2 wants the code-entry form pre-filled "from `config`", but the applet is
a single self-contained .exe with no config file to read.

### Options

1. Ship a sidecar config file — breaks the one-file download.
2. Make the user type the hostname alongside the code.
3. Bake the URL in at publish time.

### Decision

Option 3. `Applet.csproj` maps the `ServerUrl` MSBuild property into
`[assembly: AssemblyMetadata]`; `scripts/build-windows.sh` derives it from
`SERVER_URL`, else `wss://$PUBLIC_HOST/ws`. The field stays editable in the form.

### Reason

The six-digit code exists so a stressed non-technical caller types as little as
possible. Asking them for a hostname defeats it.

### Trade-offs

Re-pointing at a different server needs a rebuild — cheap, and the form override
covers the dev case. A bare hostname always normalises to `wss:`, never `ws:`.

---

## D-005 — Reconnect-with-backoff covers the initial dial only

Date: 2026-09-03

### Problem

`PLAN.md` 2.3 asks for reconnect-with-backoff on transient drop *and* a hard stop
when the session ends. Past the join, those are the same event.

### Options

1. Retry after any drop — but the relay tears the session down on peer loss and the
   code is already burned, so a reconnect can only fail.
2. Retry only while dialling; treat any post-join drop as terminal.

### Decision

Option 2.

### Reason

There is nothing to reconnect *to*: `signaling.ts` ends the session the moment either
peer's socket closes. A pre-consent drop is still recoverable and returns the user to
the code form with an error.

### Trade-offs

A brief network blip mid-session ends the session. Revisit if Phase 7's internet
testing shows real-world drops are common; that would need a server-side resumable
session token, which has its own security implications and is not POC work.

---

## D-006 — Phase 6 is done before Phase 5

Date: 2026-09-03

### Problem

`PLAN.md` orders UAC / Secure Desktop as Phase 5 and remote script execution as
Phase 6. UAC is also the project's highest-risk item, roughly 30% of the total
estimate, and the user's own priority list ranks it **last** and labels it a stretch
goal that must not block the rest of the POC.

### Options

1. Follow `PLAN.md`'s numbering and attempt UAC next.
2. Do Phase 6 (and Phase 7 deployment) first, then attempt UAC with whatever remains.

### Decision

Option 2.

### Reason

`PLAN.md` itself says Phase 5 "is the highest-risk item; if it slips, everything else
still demos" — which is an argument for making sure everything else exists first.
Phase 6 does not depend on Phase 5, is small, and completes the end-to-end POC the
user defined. Nothing in Phase 6 becomes harder by being done first.

### Trade-offs

Phase 5's console affordances stay stubbed for longer: the Ctrl+Alt+Del button
remains disabled (it needs `SendSAS` from the elevated service) and the elevation
fieldset stays inert. Both are already wired to be enabled when Phase 5 lands, and
the server-side credential guard has been in place since Phase 1.

---

## D-007 — ngrok now, DuckDNS + Caddy later, behind one compose file

Date: 2026-09-03

### Problem

Phase 7 needs a public HTTPS URL. The plan's answer is a DuckDNS subdomain with
Caddy doing Let's Encrypt, which needs an account and a token the session does not
have. Meanwhile four Windows manual tests are blocked on there being *any*
reachable HTTPS endpoint.

### Options

1. Wait for DuckDNS credentials.
2. Switch the project to ngrok permanently.
3. Support both as interchangeable compose profiles over one identical `app`
   service.

### Decision

Option 3, on the user's explicit instruction to use ngrok temporarily and not
block on DNS. `docker compose --profile ngrok` and `--profile tls` differ only in
what sits in front of the app.

### Reason

The app never needed to know how TLS is terminated: it already takes the client's
real IP and scheme from `X-Forwarded-*` under `TRUST_PROXY`, and the console
builds join links from the browser's own origin. So the migration is a profile
swap plus a `PUBLIC_HOST` change plus one applet rebuild — no application-code
change, which is exactly what the user asked to preserve.

### Trade-offs

ngrok URLs are ephemeral unless a static domain is reserved, and a new URL means
rebuilding the applet (`deploy-ngrok.sh` does it automatically). The free tier
also shows a browser interstitial on first visit, which the DuckDNS path does not.
`PLAN.md` 7.5's reasoning against a bare IP still stands and is untouched — ngrok
gives real HTTPS on a real hostname, which is the property that mattered.

---

## D-008 — The agent console gets a shared password, enforced in the app

Date: 2026-09-03

### Problem

`PLAN.md` puts console authentication out of scope, and the Phase 0 `Caddyfile`
left a TODO to add `basic_auth` "in Phase 7, not later" before the console goes on
a public hostname. Phase 7 now puts it on a public hostname — and under the ngrok
profile there is no Caddy in the path to hold that config.

### Options

1. Ship the console unauthenticated, as `PLAN.md` allows.
2. Basic auth in Caddy, as the TODO suggested.
3. Basic auth in the app, gated on an environment variable.

### Decision

Option 3. Disabled when `CONSOLE_PASSWORD` is empty (so local development is
unchanged), warned about loudly at startup, and required by
`scripts/deploy-ngrok.sh` unless `--allow-open-console` is passed.

### Reason

Option 2 protects only one of the two deployment modes, and only the console
*page*: the WebSocket is what actually creates session codes, and a proxy-level
basic_auth cannot gate it. In the app, the same credential does both — a browser
that authenticated gets an HttpOnly cookie, and `agent.create` is refused on a
socket that does not carry it, while the applet (which has no cookie and must
never need one) is unaffected.

A working remote-control console reachable by whoever finds the URL is precisely
the thing CLAUDE.md 7.5 warns about being useful to tech-support scammers.

### Trade-offs

This is not user authentication: one shared credential, no accounts, no lockout,
and the audit records that a session was created but not by whom. Real login stays
out of scope, and this must not be mistaken for it. Basic auth also means the
credential is sent on every request, which is acceptable only because both
deployment modes are HTTPS-only in practice.

---

## D-009 — One binary with three entry points, not three executables

Date: 2026-09-03

### Problem

`PLAN.md` 5.1 describes three processes — `Applet.exe`, `SecureDesktopService.exe`
and `DesktopHelper.exe` — and 5.2d says the elevated installer "writes
`SecureDesktopService.exe` to `%ProgramData%\HelpdeskAnywhere\`". It does not say
how that file reaches the machine. The applet is a single self-contained .exe
precisely so the end user downloads and double-clicks one file (PLAN 2.1), so the
other two have to travel inside it.

Measured: published self-contained and single-file, `DesktopHelper.exe` is **63 MB**
and `SecureDesktopService.exe` **34 MB**. Embedded in the 63 MB applet, that is a
**~160 MB download** for a non-technical person mid-support-call — three copies of
the same .NET runtime.

### Options

1. Embed both as resources. Faithful to the plan's wording; 160 MB.
2. Trim or make them framework-dependent. Trimming is untestable here and
   `System.Drawing` is trimming-hostile; framework-dependent means the end user
   needs a .NET install, which PLAN 2.1 exists to avoid.
3. One binary, three entry points: `--run-service` and `--desktop-helper` are modes
   of the applet, and what gets staged in `%ProgramData%` is a copy of the applet.

### Decision

Option 3. The `SecureDesktopService` and `DesktopHelper` projects keep their names,
namespaces, files and responsibilities; the applet compiles their sources in and
dispatches on the two switches before any WinForms setup. Each keeps a tiny
`Entry.cs` so it still builds and runs standalone on the Windows test machine.

### Reason

The download size is a product property, not an implementation detail: PLAN 2.1's
whole argument for a single self-contained .exe is that a stressed caller must not
have to unzip anything or install a runtime. A 160 MB download undoes that for a
feature the plan itself labels a stretch goal. Nothing else changes — the process
topology in PLAN 5.1 is identical, because these are still three *processes*; only
the number of distinct files on disk differs.

It also removes a class of bug: with one file there is no way for the applet and
the service to be built from different commits.

### Trade-offs

`%ProgramData%\HelpdeskAnywhere\HelpdeskAnywhere.exe` is a copy of the applet, so
`sc qc HelpdeskAnywhereSvc` shows the applet's path rather than a service-specific
name — slightly less obvious to an administrator reading the service list, though
the display name still says what it is. The service and helper also carry the
WinForms dependency they do not use, which costs process start time, not download
size.

`PLAN.md` 5.2d's literal wording is not followed. Recorded here rather than
silently reinterpreted.

---

## D-010 — The desktop watch runs in the user's session, not in the service

**Date:** 2026-09-05 · **Status:** accepted · **Supersedes** the session-0 polling
loop that PLAN 5.3's wording invited.

### Context

MT-06's first real Windows run failed. Elevation worked; a later UAC prompt turned
the technician canvas black instead of showing the Secure Desktop.

`DesktopWatcher` polled `OpenInputDesktop` from inside the LocalSystem service, in
session 0. That call resolves the input desktop of the window station associated
with the **calling process**, and window stations are per-session. A session-0
service is on `Service-0x0-3e7$`, which has no input desktop at all. The watch was
therefore structurally incapable of seeing `Default → Winlogon` in the interactive
session, and had been since Phase 5 was written. Nothing on Linux could see it: the
code compiles, the API exists, the call is spelled correctly, and it is simply
being made in the one place where it cannot answer.

### Decision

Split the two jobs by what each session can actually do.

* **Session 0 (`--run-service`)** keeps the one thing only it can do: hold
  `SE_TCB_NAME` and move a duplicated SYSTEM token into the interactive session. It
  is now a supervisor — start one watcher, restart it if it dies or if the console
  session changes.
* **The interactive session (`--desktop-watch`, new)** does the watching, because
  that is where `OpenInputDesktop` has an answer. It launches one `DesktopHelper`
  per input desktop with a plain `CreateProcess` and an `lpDesktop`, needing no
  token work at all — it is already SYSTEM and already in the right session.

### Alternatives considered

* **Keep the watch in the service and find another API.** There isn't one. Desktop
  enumeration is window-station scoped by design; that scoping is the security
  boundary Phase 5 exists to cross legitimately, not a limitation to route around.
* **Fold the watch into the helper.** The helper is bound to one desktop and dies on
  every switch, and thread-pool continuations inherit the *process* desktop set at
  creation — which is exactly what makes one-process-per-desktop reliable. Merging
  them would have meant explicitly re-binding every capture and injection thread.
* **A third IPC channel from an in-session probe back to the service.** More moving
  parts than simply putting the supervisor's decision where the information is.

### Consequences

* One more process while a session is elevated. Same binary (D-009), so no extra
  download, and it is killed with the process tree on teardown (constraint #4).
* PLAN 5.3's two documented failure modes (`CreateProcessAsUser` → 5, and a bare
  desktop name) now sit on a path that runs once per session instead of once per UAC
  prompt.
* The applet no longer depends on the elevated half to know a secure desktop has
  appeared: it runs in the interactive session too, so it polls the same question
  itself and stops streaming immediately (`DesktopGuard`, `StreamSource`). Even with
  the whole elevated chain broken, the canvas now freezes on the last true frame
  instead of going black.
* `PLAN.md` is unchanged and stays unchanged (D-001); this records where its
  Phase 5.3 wording, taken literally, put a call that cannot work there.

---

## D-011 — Cloudflare quick tunnel replaces ngrok as the stopgap transport

**Date:** 2026-09-05 · **Status:** accepted · **Amends** D-007, which named ngrok
as the temporary tunnel. The destination is unchanged: DuckDNS + Caddy.

### Context

On 2026-09-05 the ngrok tunnel began returning HTTP 403 `ERR_NGROK_725` — the
account had reached its monthly network bandwidth limit. The Ubuntu stack was
healthy throughout (verified 14/14 directly against the container); the edge was
refusing everything, and the cap is monthly and account-wide, so restarting or
taking a new URL from the same authtoken changes nothing.

This blocked both outstanding Windows manual tests outright, not merely
inconveniently: the applet download and the session's own WebSocket traffic cross
the same tunnel, so with it capped there is no way to run MT-01 or MT-06 at all.

The cap is a poor fit for what this tool does, and predictably so. The applet is a
**66 MB** self-contained binary, downloaded fresh on every test, and every screen
frame of every session goes through the same tunnel at 8-10 FPS. A handful of test
runs is a meaningful fraction of a free ngrok month.

### Decision

Add a `cloudflared` compose profile running a Cloudflare **quick tunnel**
(`cloudflared tunnel --url http://app:8080`), and use it as the stopgap transport
in place of ngrok. `scripts/deploy-cloudflared.sh` wraps it, mirroring
`deploy-ngrok.sh` exactly — same open-console refusal, same `PUBLIC_HOST`
reconciliation, same applet rebuild, same verification.

The ngrok profile stays in the compose file. It is not deleted, it is not the
default, and the deploy script stops it if it is running: two tunnels means two
public hostnames for one `PUBLIC_HOST`, and the `/ws` Origin policy accepts one.

### Why this satisfies the constraints CLAUDE.md actually sets

CLAUDE.md's transport rule is about **real HTTPS on a shareable hostname**, and the
two concrete failures it names are Chrome blocking an executable download over
plain HTTP, and administrator credentials crossing the public internet in
cleartext. A quick tunnel terminates TLS at Cloudflare's edge with a valid
certificate on a `trycloudflare.com` name, and proxies WebSockets. Verified, not
assumed: `verify-deployment.sh` passes 16/16 through it, including the TLS check,
the `/ws` 101 upgrade, and the foreign-Origin 403.

It is not the bare-IP-over-plain-HTTP fallback that document forbids, and it is
the same *kind* of thing ngrok was — a temporary tunnel standing in for DNS.

### Consequences

* **No account, no token, no DNS.** One fewer secret in `.env` than the ngrok path
  needed, and nothing to expire.
* **No bandwidth cap.** The reason for the change.
* **The hostname is random and changes on every restart of the tunnel.** Exactly
  the ngrok free-tier weakness, and the applet has its URL baked in at build time
  (PLAN 2.2), so a restarted tunnel silently orphans every `.exe` already
  downloaded. `restart: unless-stopped` is still correct — an unreachable tunnel is
  worse than a changed one — and the deploy script is re-runnable and reconciles
  `PUBLIC_HOST` and the `.exe` together. Called out in the script's own output and
  in `DEPLOYMENT.md`.
* **No reserved-domain option.** ngrok's free tier offers one static domain, which
  a quick tunnel does not; that is an argument for finishing the move to D-007's
  destination rather than for keeping a capped tunnel.
* The metrics endpoint is published on loopback only. Unlike ngrok's 4040
  inspector it carries no request contents — which for this app would mean session
  codes — but there is no reason to expose it further either.

### Still not the answer

D-007's destination has not moved: **DuckDNS + Caddy**, `scripts/deploy.sh`, a
stable hostname and a Let's Encrypt certificate. That needs a subdomain, a token
and ports 80/443 open on the VM. This decision buys the ability to run the Windows
tests today; it does not replace that.

---

## D-012 — The verified privileged-control architecture is regression-sensitive

**Date:** 2026-09-06 · **Status:** accepted, and **protected** · Golden tag
`hda-windows-privileged-control-working-2026-09-06`

### Context

On 2026-09-06 the whole privileged remote-control flow passed real Windows manual
testing: genuine UAC Secure Desktop visible in the technician console, remote mouse
on it, remote click **Yes** accepted, `Winlogon → Default` return, and post-UAC
control of the elevated application's buttons and menus.

Getting there took four separate real-Windows failures. Each one produced a piece
of the current design, and each of those pieces looks removable to a reader who did
not see the failure.

### Decisions being protected

Each of these is load-bearing. Changing one without understanding why it exists
will reintroduce a specific, already-observed Windows failure.

1. **Genuine Windows UAC is retained.** The prompt the technician sees is the real
   one. Never simulated, never suppressed, never replaced with a look-alike.
2. **The Secure Desktop remains enabled.** It is reached with SYSTEM privilege,
   which is the supported way; the isolation is not weakened.
3. **`WinSta0\Winlogon` is handled through the privileged helper architecture** —
   a SYSTEM process launched into the interactive session, bound to that desktop.
4. **Elevated Default-desktop applications use the privileged input route.** UIPI
   discards synthetic input from a lower integrity level, so the `--input-only`
   SYSTEM helper on `WinSta0\Default` is what makes an elevated installer
   controllable. It exists for input only; it must never capture.
5. **The session-0 service is not used for UI interaction.** Session 0 has no
   desktop the user can see. Its only unique power is `SE_TCB_NAME` and moving a
   SYSTEM token across the session boundary; it supervises and nothing else.
6. **The interactive-session helper architecture is used where required.**
   `OpenInputDesktop` is window-station scoped, so the desktop watch must run
   in-session (D-010). This is not stylistic.
7. **Authenticated local IPC.** One per-session named pipe, ACL'd to LocalSystem
   and the session's own user, with each client announcing its role.
8. **Privileged input exists only during an authorised session.** The service is
   demand-start, installed at session start, uninstalled at session end; the pipe's
   existence is the heartbeat; nothing survives a reboot.
9. **No UAC bypass. No auto-clicking UAC. No credential interception. No disabling
   of Windows security.** UIPI, UAC and the Secure Desktop are untouched; the
   applet never self-elevates; the technician's own click is the only source of a
   consent decision.

### Consequences

* `CLAUDE.md` carries a prominent regression warning naming the components covered
  by this decision, and the golden tag and branch to compare against.
* `tests/source/17`–`21` guard these invariants and were each mutation-tested.
* A future change to any named component must state why it is necessary and what it
  preserves, per the checklist in `CLAUDE.md`.

---

## D-013 — `CLAUDE.md` gains a regression-warning section (amends D-001)

**Date:** 2026-09-06 · **Status:** accepted, by explicit instruction of the project
owner

D-001 records that `PLAN.md` and `CLAUDE.md` are immutable specifications and that
findings belong in `DEV_NOTES.md`. That rule still holds for *findings*.

The owner explicitly directed that `CLAUDE.md` carry a CRITICAL REGRESSION WARNING
naming the verified privileged-control components and the golden tag, because
`CLAUDE.md` is the one document every future session reads first. A warning that
lives only in `DEV_NOTES.md` does not reach the session that is about to rewrite
`DesktopHelper`.

Scope of the amendment: `CLAUDE.md` may carry (a) the regression warning and (b)
the pointer to the golden tag and branch. It remains otherwise immutable — the
architecture, constraints and environment boundary in it are still specification,
not a scratchpad. `PLAN.md` is untouched.
