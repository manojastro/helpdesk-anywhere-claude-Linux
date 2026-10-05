# Security & Reliability Audit — 2026-10-05

| | |
|---|---|
| Branch | `audit/security-reliability-2026-10-05` |
| Starting commit (rollback point) | `2e69ad8141b223ed59d69755cb11965561af1985` (`feature/multi-session-support`) |
| Scope | Node/TypeScript server (relay, agent API, admin API, Entra sign-in, PostgreSQL records, reports), technician console, admin portal, customer join page, Windows applet + elevated service/helper (source review and cross-compile only), Docker/Caddy/tunnel deployment config, dependencies |
| Status | **AUTOMATED TEST VERIFIED (Linux)** · **WINDOWS MANUAL VERIFICATION PENDING** — see `MANUAL_TEST_PLAN.md` |

This document is written for a repository that may be public: it describes each
weakness at the level needed to understand and verify the fix, and leaves out
step-by-step exploitation detail. No credential values appear anywhere in it.

Passing automated checks does not make the application secure. This audit
reduces known risk; it does not certify the absence of other defects. The
Windows-side behaviour in particular **cannot run in this environment** (see
`CLAUDE.md` "Hard environment boundary"), and nothing here claims it passed.

---

## 1. What the application actually is (as implemented)

Verified from source, not documentation:

* **One Node 22 process, two HTTP applications.** Agent app (`PORT`, 8080):
  technician console, customer join page `/j/<code>`, applet download, `/ws`
  relay, `/api/agent/*`. Admin app (`ADMIN_PORT`, 8081): admin portal and
  `/api/admin/*`, no WebSocket. Separate cookies (`__Host-hda_agent` /
  `__Host-hda_admin`), separate `auth_sessions.portal`.
* **Authentication**: Microsoft Entra ID, OIDC code flow + PKCE via
  `openid-client` (issuer, audience, signature against JWKS, nonce, state,
  expiry validated by the library; single configured tenant enforced in
  `identity.ts`). App roles Admin / Supervisor / Agent / Auditor from the ID
  token, narrowed by a per-user DB record (pending/active/suspended + limits).
  `AUTH_MODE=dev` is a deliberate bypass for tests and is fatal under
  `NODE_ENV=production` or on a non-loopback host.
* **Relay**: in-memory session map; 6-digit single-use code (`crypto.randomInt`),
  10-minute TTL, per-IP join limit (5/min). Technician sockets are bound at
  upgrade to the cookie's identity; applet sockets are anonymous and can only
  become hosts. Nothing is relayed before customer consent. Hold is enforced at
  the relay. Up to 4 sessions per technician, checked atomically. Technician
  reconnect via a rotating 256-bit resume token (hashed server-side).
* **Records**: PostgreSQL (sessions, timeline, chat, notes, reports, admin audit
  trail) plus an append-only JSONL audit file with key-based credential redaction.
* **Windows**: one self-contained .exe with several modes — applet (user),
  elevated installer (UAC), LocalSystem service (`--run-service`), desktop
  helper on Winlogon (`--desktop-helper`), in-session desktop watcher. IPC is a
  per-session named pipe ACL'd to LocalSystem + the customer's SID. The
  service binary is staged in `%ProgramData%\HelpdeskAnywhere` with a
  protected SYSTEM + Administrators DACL and removed at session end.
* **Not present**: there is **no file-transfer feature** in this codebase (no
  upload/download of customer files), so the file-transfer checks in the audit
  brief do not apply. Multiple-monitor support is a virtual-desktop capture; no
  monitor picker exists.

---

## 2. Confirmed findings

Severity reflects realistic impact in this product's threat model (a
consent-based support tool reachable from the internet, running a SYSTEM
service on customer machines during elevated sessions).

### High

#### F-01 — SYSTEM scripts staged in a directory any local user can control
* **Component**: `windows/SecureDesktopService/ServiceLink.cs` (`ExecuteAsync`).
* **Root cause**: "Run as SYSTEM" scripts were written to
  `Path.GetTempPath()\HelpdeskAnywhere-system`. For LocalSystem that is
  `C:\Windows\Temp` on Windows 10 (and Windows 11 builds without SystemTemp),
  where unprivileged users may create subdirectories and own them. The code
  reused an existing directory without checking who owned it. Interpreters
  were also started by bare name (`cmd.exe`, `powershell.exe`).
* **Impact**: a local unprivileged account on the customer's machine (including
  a *different* user from the one being helped) could prepare that directory in
  advance and alter a staged script before the SYSTEM process read it — local
  privilege escalation to SYSTEM during any session in which the technician runs
  a SYSTEM script. This is the same class of bug the payload directory had
  already been fixed for (`ElevationPayload.PrepareInstallDirectory`).
* **Evidence**: source review; reasoning from the documented default DACL of
  `C:\Windows\Temp`. Not reproduced on Windows (environment unavailable).
* **Fix**: scripts are now staged in `<service exe dir>\scripts`, i.e.
  `%ProgramData%\HelpdeskAnywhere\scripts`, which inherits the protected
  SYSTEM + Administrators DACL that `ElevationPayload` creates (after deleting any
  pre-existing directory) and is removed on uninstall. `cmd.exe` and
  `powershell.exe` are launched by absolute `System32` path. No pipe, desktop,
  input or elevation logic was changed.
* **Golden-checkpoint handling**: `ServiceLink.cs` is inside the protected
  privileged-control area. The change is limited to script staging, and is
  recorded as a hash-pinned approved delta (`tests/lib/approved-windows-deltas.mjs`):
  the golden-diff guards (`source/25`, `source/27`) still fail on any other change
  to that file, or to any other privileged file.
* **Verification**: `tests/source/28-audit-invariants.mjs` [F-01] (6 checks);
  mutation-tested (reverting either half turns it red). Windows solution
  cross-compiles (0 errors). **Windows run: not performed — MANUAL_TEST_PLAN
  T-04/T-05 required.**

### Medium

#### F-02 — Admin credentials could cross the customer's leg in cleartext
* **Component**: `server/src/signaling.ts` `relayElevation`.
* **Root cause**: credential-mode elevation was refused only when the
  *technician's* socket was insecure. The customer's applet can dial plain
  `ws://` (its server-address parser accepts `http://`/`ws://`), and the relay
  then forwarded the administrator password to it unencrypted.
* **Impact**: breaks CLAUDE.md constraint #6 ("must be refused outright over a
  non-TLS connection") on one of the two legs; the password crosses the public
  internet in cleartext if the applet is pointed at a non-TLS address.
* **Fix**: refused unless **both** connections arrived over TLS
  (`insecure_transport`, audit record notes which leg). Spec updated in
  `shared/protocol.md`.
* **Verification**: `ws/11` [F-02] (refused, nothing reaches the customer);
  `source/28` [F-02]; runtime mutation turns ws/11 red.

#### F-03 — Removing "can use console" did not stop live control
* **Component**: `signaling.ts` `agentBlocked`, `applyUserAccessChange`.
* **Root cause**: the per-message re-check looked at status and sign-in expiry,
  not `console.use`. An admin clearing a user's console permission left that user
  `active`, so their open sockets kept sending input to customers.
* **Impact**: an access-revocation control that silently did not apply to
  sessions already in progress.
* **Fix**: `console.use` is part of the per-message check, and losing it is
  treated as a revocation: the user's sessions end and sockets close (`4403`)
  immediately, including sessions inside the reconnect grace.
* **Verification**: `ws/11` [F-03] (admin PATCH → both sockets closed,
  `access_revoked`, new create refused); runtime mutation turns it red.

#### F-04 — Signing out did not end the relay sockets opened with that sign-in
* **Component**: `routes/auth.ts` (`POST /auth/logout`), `signaling.ts`.
* **Root cause**: logout deleted the cookie's `auth_sessions` row, but a socket
  is bound to its identity at upgrade and only re-checked expiry, so it kept
  working for up to `AUTH_MAX_HOURS`.
* **Impact**: a technician who signs out on a shared machine expecting control to
  stop leaves live sessions controllable.
* **Fix**: `revokeAuthSession(sessionHash)` ends every relay socket opened with
  *that* sign-in at logout. A separate sign-in of the same person (another
  browser) is unaffected. **Behaviour change**: signing out now ends that
  console's live sessions (end reason `agent_session_expired`) instead of leaving
  them resumable after a re-login in the same tab.
* **Verification**: `ws/11` [F-04] (that sign-in's sessions end; another
  sign-in's session survives); runtime mutation turns it red.

#### F-05 — Unrecognised technician messages were forwarded to the customer verbatim
* **Component**: `signaling.ts` `handleAgentMessage`.
* **Root cause**: deny-list dispatch: anything starting `agent.` that no branch
  handled fell through to a raw forward — including while the session was on
  hold, because the hold check only recognises three action types.
* **Impact**: the relay is the enforcement point for hold and permissions; an
  unknown type bypassed both and relied on the applet ignoring it. Defence-in-depth
  gap against future message types and applet parser behaviour.
* **Fix**: allow-list: only `agent.input` with `kind` ∈ {mouse, key, sas} is
  forwarded raw; everything else gets a `protocol` error. All message types the
  console actually sends were checked against the list.
* **Verification**: `ws/11` [F-05] (active and held); runtime mutation turns it red.

#### F-08 — Unlimited anonymous WebSocket connections per IP
* **Component**: `signaling.ts` `verifyClient`; `config.ts`.
* **Root cause**: anonymous (applet) sockets had no per-source limit and need no
  role to stay open (heartbeat keeps them alive).
* **Impact**: one client can hold an unbounded number of sockets (file
  descriptors, memory), degrading the relay for every customer.
* **Fix**: `MAX_ANON_SOCKETS_PER_IP` (default 20) — the next anonymous upgrade
  gets HTTP 429. Signed-in technician sockets are not counted. Exposed in
  `docker-compose.yml`.
* **Verification**: `ws/11` [F-08]; runtime mutation turns it red.

#### F-09 — No backpressure on video to a slow technician
* **Component**: `signaling.ts` binary path (now `relayVideo`).
* **Root cause**: every host frame was `send()`-queued to the technician socket
  regardless of `bufferedAmount`.
* **Impact**: on a slow or stalled technician link the relay buffers video
  without bound in server memory (frames up to 8 MB) — a reliability and
  availability problem affecting all sessions on the server.
* **Fix**: above 4 MB queued, frames are skipped; when the buffer drains, the
  session's existing catch-up buffer (last keyframe + rects since) is replayed so
  the picture is rebuilt exactly rather than left with stale regions.
* **Verification**: `ws/11` [F-09] (stalled reader: 15 of 81 × 512 KB frames
  queued instead of 81; keyframe replay after drain); runtime mutation turns it red.

### Low

#### F-10 — A supervisor with no team could list every team-less user
* **Component**: `routes/adminApi.ts` `GET /users`, `GET /dashboard`.
* **Root cause**: `team_id IS NOT DISTINCT FROM $teamId` with a NULL team matched
  all users who have no team — including administrators.
* **Impact**: disclosure of names, e-mail addresses and Entra object IDs beyond the
  documented "supervisor: own team" scope.
* **Fix**: a team-less supervisor sees only their own record.
* **Verification**: `ws/11` [F-10]; mutation confirmed the leak returns
  (`["Audit Tech","Loose Tech","Suite Admin",…]`).

#### F-06 — Unbounded self-reported device fields
* **Component**: `signaling.ts` `handleHostJoin`.
* **Root cause**: machine/user/OS strings from an unauthenticated client were
  only bounded by the 256 KB frame cap before reaching the audit file, timeline
  JSON, the technician console and admin views (the DB columns alone truncated).
* **Fix**: string-only, control characters stripped, 200 characters max.
* **Verification**: `ws/11` [F-06]; runtime mutation turns it red.

#### F-07 — One chat rate-limit bucket shared by both sides
* **Component**: `signaling.ts` `relayAgentChat` / `relayHostChat`.
* **Impact**: a flooding customer applet could exhaust the technician's chat
  allowance (and vice versa).
* **Fix**: separate buckets per side.
* **Verification**: `ws/11` [F-07]; runtime mutation turns it red.

---

## 3. Unverified concerns and accepted limitations

Not fixed here, with the reason. None is hidden; each needs either a product
decision or real Windows hardware.

| ID | Concern | Why not fixed / status |
|---|---|---|
| A-1 | **Session-code guessing from many IPs.** 6 digits (1e6) with a per-IP limit; a widely distributed attacker could eventually claim a live code and pose as the customer. Consent is shown on *their* machine, so the protection is the technician noticing the wrong device — and credential elevation would send admin credentials to that device. | Product decision (longer codes or link-only join, a global failed-join alarm). Recommendation: technicians confirm the machine/user shown in the console with the customer **before** credential elevation. |
| A-2 | **Code running as the customer user can reach the elevated service while a session is elevated.** The SYSTEM service trusts the pipe server, which is the user-level applet; same-user code can impersonate or inject into the applet. | Architectural: inherent to an unelevated applet brokering a SYSTEM helper (pipe server-PID checks would only raise the bar). Bounded by: service exists only during an elevated session, removed at session end. Documented, not changed (golden area). |
| A-3 | Removing an Entra **app role** takes effect at the user's next sign-in (≤ `AUTH_MAX_HOURS`, default 12 h) — roles are captured per browser session. | Suspension or clearing limits in the admin portal is immediate (verified by F-03/F-04 tests). Operational guidance: suspend in the portal as well as in Entra. |
| A-4 | Full script text is stored in the JSONL audit file (PLAN 1.6). A script containing a secret puts it there. | By design (constraint #5). Treat `./audit` as sensitive; restrict host access. |
| A-5 | `/healthz` reveals public hostname, auth mode and uptime unauthenticated. | Low value; used by deploy checks. Accepted. |
| A-6 | `cloudflare/cloudflared:latest` is not version-pinned. | Temporary transport profile; pin a digest for any lasting deployment. |
| A-7 | `POST /auth/logout` requires a valid session, so an already-expired cookie is not cleared server-side. | Harmless (the row is already gone or rejected). |
| A-8 | The development sign-in form (an intentional auth bypass) ships in the image. | Fatal at startup under production / non-loopback (`api/34` asserts it). |

---

## 4. Areas reviewed with no finding

* **SQL injection**: every query parameterised; dynamic `LIMIT/OFFSET` built
  from clamped integers; sort columns from a fixed map; `LIKE` input escaped.
* **Authorisation**: every `/api/admin` and `/api/agent` route checks a server-side
  permission and scopes by organisation (+ team / own); sessions, transcripts,
  notes, reports re-checked per request; report downloads requester-only with
  audit; terminate requires `sessions.terminate` and scope. Agent API exposes
  only the caller's own sessions/notes.
* **CSRF**: per-session token header + Origin check on every state change;
  SameSite=Lax as a third layer.
* **Cookies**: `__Host-`, Secure, HttpOnly, SameSite=Lax; DB stores only SHA-256
  of the token; idle + absolute expiry; suspension deletes sessions.
* **OIDC**: PKCE, state, nonce, JWKS signature (`enableNonRepudiationChecks`),
  issuer/audience, single tenant, single-use server-side transaction,
  cross-portal transaction refused, open redirect blocked (`safeReturnTo`).
* **WebSocket**: cross-site origin refused; browser upgrade without a valid
  sign-in refused; control frames ≤ 256 KB; malformed JSON closes; first message
  declares the role; host cannot send binary before consent; resume requires
  owner + current token (hashed, rotated, constant-time).
* **XSS**: console, admin portal and join page render untrusted text with
  `textContent`/created elements only; links pass an http(s) allow-list; CSP
  `script-src 'self'`, `frame-ancestors 'none'`.
* **CSV formula injection**: handled in `csvCell` (`= + - @ \t \r` prefixed).
* **Path traversal**: static gate normalises `..`/percent-encoding before
  matching; script ids sanitised on both Windows paths.
* **Secrets**: none committed (working tree and full history scanned for common
  token/key patterns; only placeholders found). `.env*` are git-ignored and
  mode 600.
* **Deployment**: DB not published; admin port loopback-only on the host; HSTS;
  dev sign-in and `ALLOW_INSECURE_DEV` fatal on real hosts; non-root container;
  log rotation.
* **Windows**: pipe ACL (SYSTEM + customer SID); service install directory
  protected DACL with pre-existing directory removal; manifest/startup invariants
  (existing `source/15`–`21`).

---

## 5. Dependencies and tooling

| Check | Result |
|---|---|
| `npm audit` (all deps, and `--omit=dev`) | 0 vulnerabilities |
| `dotnet list package --vulnerable --include-transitive` (all 4 projects) | none |
| `tsc` strict build | clean |
| `dotnet build windows/HelpdeskAnywhere.sln -c Release` | 0 errors, 1 pre-existing warning (WFAC010, high-DPI manifest setting) |
| Secret scan (tracked files + history) | placeholders only |

No dependency upgrades were needed or made; lockfiles are unchanged.

---

## 6. Verification summary

| Suite | Before (baseline) | After |
|---|---|---|
| `./scripts/run-tests.sh` (ws, api, source, dotnet, browser) | 44 / 44 blocks green | **46 / 46 blocks green** (44 existing + 2 new) |
| New `ws/11` audit regression block | — | 35 / 35 |
| New `source/28` audit invariants | — | 24 / 24 |
| Source-invariant mutations (`source/28` + `source/25`) | — | 12 / 12 detected |
| Runtime mutations (`ws/11` against a rebuilt server, one fix reverted each) | — | 9 / 9 detected (F-02 … F-10) |

### 6.1 Full-suite result after the fixes

`./scripts/run-tests.sh` on 2026-10-05: **46 blocks passed, 0 failed** — every
pre-existing block (relay state machine, hold, chat, multi-session, access
control, persistence, restart, reports, startup refusal, Windows source
invariants incl. the golden-checkpoint guards, .NET unit tests, solution build,
and all headless-browser console/admin-portal blocks) plus `ws/11` and
`source/28`. No existing test was weakened or removed; `source/25` and
`source/27` were extended to accept only the hash-pinned F-01 delta.

### 6.2 Not run (environment required)

Everything that executes on Windows: capture, input, UAC / Secure Desktop,
elevated-application input, the SYSTEM script path changed by F-01, applet
reconnect behaviour, multi-monitor/DPI. See `MANUAL_TEST_PLAN.md`; every such
row is marked **Not run — environment required**.

---

## 7. Rollback

All changes are on branch `audit/security-reliability-2026-10-05`, created from
`2e69ad8`. Nothing was pushed, deployed, or applied to the running containers.

```bash
# discard the whole audit (branch not merged anywhere yet)
git switch feature/multi-session-support
git branch -D audit/security-reliability-2026-10-05

# or, after it has been merged, revert just the audit commit(s)
git revert <audit-commit-sha>

# Windows only (F-01), if a real-Windows regression appears:
git diff hda-windows-privileged-control-working-2026-09-06 -- windows/SecureDesktopService/ServiceLink.cs
git checkout 2e69ad8 -- windows/SecureDesktopService/ServiceLink.cs   # restores golden ServiceLink
# then remove its entry from tests/lib/approved-windows-deltas.mjs and rebuild the .exe
```

New configuration (`MAX_ANON_SOCKETS_PER_IP`) has a safe default; removing it
from `.env` restores the default, not the old unlimited behaviour.
