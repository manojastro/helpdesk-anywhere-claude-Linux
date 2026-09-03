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
