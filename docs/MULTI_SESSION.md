# Multi-session support — up to four live sessions per technician

Branch `feature/multi-session-support` (from `feature/admin-portal` @ `22ce263`),
2026-09-28. Status: **AUTOMATED TEST VERIFIED**, **MANUAL ACCEPTANCE PENDING** (MT-11).

Scope decisions taken with the project owner before implementation:

| Decision | Choice | Why |
|---|---|---|
| File transfer | **Separate follow-up** | It does not exist yet — no applet code, no relay code. Building it means new applet C#, a rebuild and a real-Windows retest; it will be designed per-session from day one. |
| Reconnect | **Technician side only** | Browser drop / page reload needs no applet change. Customer-side reconnect needs the applet to stop hard-exiting on a drop (`SessionClient.cs`), so it goes with the file-transfer applet work. |
| Limit | **Ceiling 4, default 4** | `MAX_CONCURRENT_SESSIONS_PER_AGENT=4`; effective limit `min(account limit, ceiling)`; accounts on the old default 3 migrated to 4. |

**No file under `windows/` changed** (asserted by `tests/source/27`).

---

## A. Architecture — before and after

```
BEFORE                                         AFTER
──────                                         ─────
Console (one page)                             Console (one page)
  module globals: ws, canvas, heldKeys,          SessionManager { sessions[≤4], selected, layout }
  held, elevated, chat, script, timers           ├── RemoteSession A ── ws A ── canvas A ── chat A …
  └── ws ─────────────┐                          ├── RemoteSession B ── ws B ── canvas B ── chat B …
                      │                          ├── RemoteSession C ── ws C …
Relay                 ▼                          └── RemoteSession D ── ws D …
  agent socket ⇄ session ⇄ host socket                        │ one socket per session
  agent drop  ⇒ session ends                     Relay         ▼
                                                   agent socket ⇄ session ⇄ host socket   (×4, unchanged binding)
                                                   limit: min(account, 4), checked+reserved atomically
                                                   agent drop ⇒ 60 s grace, slot kept, resume by owner+token
                                                   per-session catch-up buffer; keyframes-only for background
```

The relay was already one-socket-per-session: a technician socket is bound to one
session at `agent.create` and every message is routed by the socket it arrived on.
That is the strongest isolation available — there is no `sessionId` in any message
body for a client to forge — so it was **kept**, and the console now opens one socket
per session instead of adding session ids to the wire.

### Relay (`server/src`)

* `sessions.ts` — `Session` gains `resumeTokenHash`, `resumeIssued`, `reconnect`
  (grace timer), `reconnectCount`, `viewPriority`, `catchUp` (last keyframe + rects
  since, ≤3 MB), `elevated`, `desktop`. `countForUser()` documents the atomicity
  contract; `issueResumeToken()` / `resumeTokenMatches()` (SHA-256, constant time).
* `signaling.ts` — limit enforcement with `maxSessions`/`activeSessions`;
  `agent.resume` (auth + ownership + token, takeover with `4409`); reconnect grace
  instead of immediate teardown; `agent.view` keyframes-only forwarding and catch-up
  replay; revocation also ends sessions waiting in grace; sweeper safety net.
* `records.ts` — `agent.reconnecting` / `agent.reconnected` / `agent.reconnect_expired`
  timeline events, `reconnect_count`, `last_disconnect_reason`, chat replay query.
* `routes/agentApi.ts` — `GET /api/agent/sessions/live`; `maxSessions` on `/me`.
* `routes/adminApi.ts` — `GET /api/admin/technicians/live`; limits capped at the ceiling.

### Session lifecycle

```
relay:    waiting_for_host → waiting_for_consent → active → ended
                                                    │  ▲
technician socket drops (no agent.end) ─────────────┘  │ agent.resume (owner + token)
          session keeps its slot, grace 60 s ──────────┘
          grace expires → ended (agent_disconnected), slot released

console:  connecting → waiting → consent → connected ⇄ reconnecting
          terminal: ended | failed (tab leaves the strip)
```

The relay's durable `sessions.status` values are unchanged (the reconnecting state
lives in memory, like everything else about a live socket); the record carries
`reconnect_count` and `last_disconnect_reason`, and the timeline the events.

### Console (`server/public/portal.js`)

`RemoteSession` owns everything that used to be a module global. The shared DOM (all
existing element ids) always shows the **selected** session; per-session content (chat
log, script output/history, event logs) is parked in the session's own
`DocumentFragment` while it is not selected. Each session has its own `<canvas>` in its
own tile; the selected one carries `id="remote"`.

* **Tabs** (default): the selected tile fills the viewport exactly as the single canvas
  did (`display: contents` keeps the old container-query sizing).
* **Grid** (2–4 sessions): monitoring. Clicking a tile *selects* it and sends nothing;
  only the selected tile — outlined, "CONTROL ACTIVE" — receives input. Grid forces Fit
  and disables zoom/magnifier so no view aid can be ambiguous.
* **Strip**: device, state (text + dot), duration, stream-quality bars, unread badge,
  per-session ✕; "Active Sessions: n / 4" summary; Tabs/Grid; Disconnect all (confirmed).
* **Notifications** for background sessions (chat, consent, UAC prompt, script finished,
  interruption, end). Clicking one selects that session; nothing ever switches on its own.
* **Ctrl+Shift+1…4** selects a session. Not Ctrl+1…4: browsers reserve those for their
  own tabs, and Ctrl+digit is a real shortcut in Windows applications.
* **Session info** tab: id, technician, remote user/device/OS, state, start, duration,
  relay method, reconnects, elevation/UAC, video received, frame rate, chat and script
  counts. The customer IP is deliberately not shown to technicians.
* **Resource use**: non-selected sessions ask the relay for `preview` (keyframes only).
  One 1-second ticker for all sessions instead of timers per session.
* **Failure isolation**: every socket handler runs inside a per-session try/catch;
  a stale socket (replaced by a resume) can never touch its session again.

## B. Files changed

| File | Purpose | Important change |
|---|---|---|
| `server/src/config.ts` | configuration | `MAX_CONCURRENT_SESSIONS_PER_AGENT` (4), `AGENT_RECONNECT_GRACE_MS` (60 000), `RESUME_ATTEMPTS_PER_MINUTE` |
| `server/src/startupChecks.ts` | refuse bad config | ceiling 1–20, grace 0–600 000 |
| `server/src/protocol.ts` | wire types | `agent.resume`, `agent.view`, `session.resumed`, `chat.history`, `resume_failed`, `maxSessions`/`activeSessions`, `resumeToken` |
| `server/src/sessions.ts` | live-session store | per-session reconnect/priority/catch-up state, resume tokens, `forUser()` |
| `server/src/signaling.ts` | relay | limit, resume, grace, preview forwarding, revocation in grace |
| `server/src/records.ts` | durable record | reconnect events and columns, chat replay |
| `server/src/audit.ts` | JSONL audit | new events; `resumeToken` redacted |
| `server/src/reports.ts` | titles / safe detail keys | reconnect events readable in history and PDFs |
| `server/src/sessionQueries.ts`, `routes/adminApi.ts` | admin API | `reconnectCount` on sessions; `/technicians/live`; ceiling on limits; `sessionCeiling` on `/me` |
| `server/src/routes/agentApi.ts` | console API | `/sessions/live`, `maxSessions` |
| `server/migrations/002_multi_session.sql` | schema | default limit 4, `reconnect_count`, `last_disconnect_reason/_at`, `(org, agent, status)` index |
| `server/public/portal.js` | console | rewritten around `RemoteSession` / manager (see above) |
| `server/public/portal.html`, `portal.css` | console UI | strip, tiles, grid, Info tab, limit and disconnect-all dialogs, toasts |
| `admin-portal/public/app.js`, `app.css` | admin UI | technicians' concurrency table with slot meter and drill-down; limit input capped |
| `shared/protocol.md` | protocol source of truth | "Multi-session" section |
| `.env.example`, `docker-compose.yml` | deployment | the two new settings (compose passes an explicit list) |
| `tests/ws/10-multi-session.mjs` | relay tests | 56 + 7 checks |
| `tests/browser/26-multi-session.mjs` | console tests | 48 checks |
| `tests/source/27-multi-session-invariants.mjs` | static invariants | 10 checks |
| `tests/browser/17-console-shell.mjs` | updated | New Session is no longer disabled during a session |
| `tests/run-all.sh` | suite | the new blocks |

## C. Database changes

`server/migrations/002_multi_session.sql` (forward-only, applied at startup under the
advisory lock like 001):

* `users.max_concurrent_sessions` default 3 → **4**; rows still at 3 → 4.
* `sessions.reconnect_count integer NOT NULL DEFAULT 0`
* `sessions.last_disconnect_reason text`, `sessions.last_disconnect_at timestamptz`
* index `sessions_org_agent_status_idx (org_id, agent_user_id, status)`

The spec's suggested `id / technician_id / status / created_at` indexes already exist
(`sessions_org_agent_created_idx`, `sessions_org_status_idx`, `sessions_org_created_idx`).
Chat was already stored per session (`chat_messages.session_id`, sender role and user,
timestamp); nothing was needed there.

## D. API / WebSocket changes

WebSocket — see `shared/protocol.md` "Multi-session":

| Message | Direction | |
|---|---|---|
| `session.created` + `resumeToken` | → agent | per-session resume secret |
| `agent.resume {sessionId, resumeToken}` | agent → relay | first message on a new socket |
| `session.resumed {…}` + catch-up frames + `chat.history` | → agent | |
| `agent.view {priority}` | agent → relay | never forwarded to the host |
| `error session_limit {maxSessions, activeSessions}` | → agent | spec message text |
| `error resume_failed` | → agent | uniform refusal; also to a taken-over socket |

HTTP:

| Endpoint | |
|---|---|
| `GET /api/agent/sessions/live` | the caller's own live sessions and `maxSessions` (no codes, no tokens) |
| `GET /api/agent/me` | + `user.maxSessions` |
| `GET /api/admin/technicians/live` | per technician: active / limit, reconnecting, sessions (device, state, start, duration, chat **count**) |
| `GET /api/admin/me` | + `sessionCeiling` |
| `PATCH /api/admin/users/:id` | `maxConcurrentSessions` above the ceiling → `400 invalid_limit {max}` |

## E. Security review — why nothing crosses sessions

| Threat | Control |
|---|---|
| Input/chat/script/elevation for session A reaching B | One socket per session, bound by the relay at create/resume; no session id in any message body. Console listeners are per canvas, send on that session's socket, and only while it is selected. Drafts (script, chat, notes) are per session; typed admin credentials are cleared on every switch; Send URL is bound to the session it was opened for. |
| Screen frames of A shown for B | Frames arrive on A's socket and are painted on A's canvas by A's own render chain; a frame queued for a disposed session is dropped. |
| Keys stuck down on the machine you switched away from | `select()` releases every held key and mouse button on the old session first; a key-up is forwarded only for a key that went down on that same session (the tail of the switch shortcut can't leak). |
| Taking over someone else's session by changing a session id | `agent.resume` requires the signed-in technician to **own** the session and present its **current** 256-bit token (hashed, constant-time, rotated, redacted from logs). A session id alone grants nothing; failures are uniform. |
| A revoked technician's sessions surviving in the grace period | Suspension ends sessions in grace immediately (`ws/10` [H]). |
| Exceeding four via concurrent requests | Count and reservation in one synchronous turn; tested with a 2-way and a 6-way race, and mutation-tested (an injected `await` lets 6/6 through and the tests go red). |
| Stale sessions after a crash or closed browser | Grace timer + sweeper safety net release the slot; server restart reconciliation unchanged. |
| Resume token theft | Kept only in the owning tab's `sessionStorage`, useless without that technician's own sign-in cookie, rotated on use, dies with the session. CSP (`script-src 'self'`) unchanged. |
| Customer privacy | The applet sees no new message; admins see chat counts only; technicians do not see customer IPs. |

## F. Testing report (2026-09-28, this VM)

| Block | Result |
|---|---|
| `ws/01–09` (existing relay) | all pass, unchanged |
| **`ws/10` multi-session** | **56 / 56** |
| **`ws/10b` grace expiry** | **7 / 7** |
| `api/30–34` (existing) | all pass, unchanged (incl. the per-user limit test) |
| `browser/10–16, 22–24` (existing) | all pass, unchanged |
| `browser/17` console shell | 74 / 74 after updating one assertion that encoded "one session at a time" |
| **`browser/26` multi-session console** | **48 / 48** |
| `source/15–25` (Windows invariants, golden) | all pass |
| **`source/27` multi-session invariants** | **10 / 10** |
| Mutation M1: `await` between limit check and create | ws/10 race checks and source/27 go red (6/6 creates succeed) |
| Mutation M2: ownership check removed from resume | ws/10 [D] "another technician with the RIGHT token is refused" goes red |
| Mutation M3: forward every key-up | browser/26 [C] "the Digit1 of the shortcut reached no machine" goes red (found as a real bug and fixed) |

Manual real-Windows acceptance: **MT-11, pending** (`MANUAL_TESTS.md`).

## G. Performance observations

Measured on this VM (headless Chrome console, 4 applet-shaped hosts streaming at the
applet's cadence: 10 fps, a 1920×1080 keyframe (657 KB, noise — worst case) every 5 s
and a 27 KB dirty rect otherwise; 20 s per layout):

| | Tabs | Grid |
|---|---|---|
| Relay CPU | 1.3 % | 1.3 % |
| Relay RSS | 110 MB | 111 MB |
| Sockets | 8 (4 technician + 4 host) | 8 |
| Selected session received | 100 % of bytes | 100 % |
| Each background session received | **34 %** of bytes, **1 decode / 5 s instead of 50** | 34 % |
| Console main thread busy | 3.1 % | 4.8 % |
| Console JS heap | 1.3 MB | 1.4 MB |

With real desktops the dirty rects are far smaller than this noise test, so the
background saving in bytes is larger; the decode saving (98 %) holds regardless.

Leak check — 11 cycles of "open four sessions, Disconnect all" (44 sessions): console
event listeners back to the idle 62, DOM nodes back to idle, one tile and no tabs left,
relay live sessions 0, and established connections on the relay port down from 8
during the run to 1 (no session socket remains). Relay RSS 98 → 112 MB across the whole
run (Node buffer pools after ~30 MB of relayed video), not growing per cycle.

## H. Remaining risks — not hidden

1. **Nothing here has run against a real Windows applet yet** (MT-11). The applet is
   unchanged, so the privileged path (UAC, Secure Desktop) is the verified one, but four
   applets against one console has only been exercised with applet-shaped test sockets.
2. **The exe the owner verified today (`435bbe5f…`, golden build) predates applet-side
   chat and the hold indicator** (Feature Batches 1–2 changed `windows/` after the
   golden commit). Technician → customer chat is relayed and stored but that exe ignores
   it; testing chat isolation on Windows needs a build of the current source, which is
   itself unverified (MT-08 pending).
3. **File transfer does not exist** (separate follow-up, per decision). The Info panel says so.
4. **Customer-side reconnect** is not implemented: if a customer's network drops, that one
   session ends exactly as before (and only that one).
5. **A closed browser tab holds its sessions for the 60 s grace** before they end
   (reload and close are indistinguishable to the relay). Use End / Disconnect all to
   release immediately.
6. **Background video is a keyframe every ≤5 s.** In grid, non-selected tiles are
   monitoring thumbnails, not live video. Switching is exact and immediate (catch-up replay).
7. **Single relay process** is assumed for the atomic limit — as the admin-portal release
   already assumes for reconciliation. Horizontal scaling would need the count in the DB.
8. The resume token lives in `sessionStorage`; an XSS in the console could read it — but
   it would also have the technician's live sockets, and CSP forbids inline script.
