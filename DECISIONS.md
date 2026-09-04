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
