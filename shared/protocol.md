# Helpdesk Anywhere — wire protocol

**This file is the single source of truth.** It is mirrored in
`server/src/protocol.ts` and `windows/Shared/Protocol.cs`. **Change all three
together** (CLAUDE.md conventions).

## Transport

A single WSS endpoint: `wss://$PUBLIC_HOST/ws`.

- **Control messages** are JSON text frames, each an object with a `t` discriminator.
- **Video** is sent as binary frames: first byte = frame type, remainder = payload.

The first message a socket sends declares its role — `agent.create` (agent console) or
`host.join` (Windows applet). A socket that sends anything else first is closed.

## State machine

```
waiting_for_host  --host.join-->  waiting_for_consent  --host.consent{true}-->  active
       |                                   |                                      |
       +---- code TTL expires ---> ended <-+---- host.consent{false} -------------+
                                     ^                                            |
                                     +------- agent.end / either peer drops -------+
```

The relay **drops any frame arriving before `state === "active"`**.
Codes are 6-digit, single-use (burned on host join), and expire after 10 minutes unused.

---

## Agent → server

| Message | Notes |
|---|---|
| `{ t:"agent.create" }` | → `{ t:"session.created", code:"482913", sessionId:"<uuid>", resumeToken:"..." }`. **Requires a signed-in technician** (admin-portal release, see "Identity on the socket"). Refused with `session_limit` at the technician's concurrent-session limit (multi-session, below). |
| `{ t:"agent.input", kind:"mouse"\|"key"\|"sas", ... }` | Phase 4. Relayed to host. |
| `{ t:"agent.exec", id:"...", shell:"powershell"\|"cmd", script:"...", asSystem:bool, libraryRef?:{id, version} }` | Phase 6. Audited with full script text **before** the process starts. Platform 2.0: optional `libraryRef` names a saved-library script; the relay records it as that script only if text (SHA-256), shell and privilege match exactly, otherwise `libraryMismatch`. Forwarded verbatim; the applet ignores the field. |
| `{ t:"agent.requestElevation", mode:"interactive" }` | Phase 5.2a — end user is a local admin; Windows shows its native consent prompt. |
| `{ t:"agent.requestElevation", mode:"credential", domain, username, password }` | Phase 5.2b. **`password` is NEVER logged** — see below. |
| `{ t:"agent.hold", held:bool }` | Feature Batch 1. Pauses/resumes technician control. See below. |
| `{ t:"agent.chat", kind:"text", text:"...", clientId:"..." }` | Feature Batch 2. Plain-text chat. See below. |
| `{ t:"agent.chat", kind:"url", url:"...", label?:"...", clientId:"..." }` | Feature Batch 2. Send URL — a specialised chat item. |
| `{ t:"agent.notes.save", length:int }` | Feature Batch 2. Technician-private notes. See below. |
| `{ t:"agent.end" }` | Tears down both sides. |
| `{ t:"agent.resume", sessionId:"<uuid>", resumeToken:"..." }` | Multi-session. First message on a NEW technician socket: pick a live session back up after the old socket dropped. See "Multi-session" below. |
| `{ t:"agent.view", priority:"full"\|"preview" }` | Multi-session. Consumed by the relay, **never forwarded to the host**. See "Multi-session" below. |

### `agent.input` payloads (Phase 4)

```jsonc
{ t:"agent.input", kind:"mouse", x:1234, y:567,
  button:0|1|2|null, action:"move"|"down"|"up"|"wheel", wheelDelta?:-120 }

{ t:"agent.input", kind:"key", code:"KeyA", action:"down"|"up" }

{ t:"agent.input", kind:"sas", action:"press" }
```

`x`/`y` are **remote pixels** in virtual-desktop space, mapped by the console from the
canvas backing store (not the CSS size). `code` is the DOM `event.code` (physical key),
not `event.key`, so keyboard layout differences do not scramble input.

`kind:"sas"` is Ctrl+Alt+Del, and is deliberately **not** a key chord: the Secure
Attention Sequence cannot be produced by `SendInput` at all — that is the whole point of
it. The applet routes it to the elevated service's `SendSAS()`, so the console's button
stays disabled until `host.elevated { ok:true }` arrives (PLAN 4.3, 5.3). `action` is
always `"press"`; it is present only because every `agent.input` carries one.

### `agent.hold` — pausing technician control (Feature Batch 1)

`{ t:"agent.hold", held:true }` puts a live session **on hold**: the agent stops
driving the customer's machine without ending the session. `held:false` resumes it.

The session stays `active` throughout — the socket, the applet, the consent and the
video stream are all untouched, so the agent keeps *seeing* the machine and the
customer keeps seeing their session indicator. Only the agent→host action channel
closes.

**The relay enforces it; it is not a promise the browser makes to itself.** While a
session is held:

- `agent.input` is **dropped silently**. It is high-frequency and inherently racy —
  a mouse-move already in flight when Hold was pressed must not produce an error
  that the console would paint over a live session.
- `agent.exec` and `agent.requestElevation` are **refused** with
  `code:"session_held"`. Both are deliberate, one-shot actions, so silently doing
  nothing would be worse than saying no.

`agent.hold` is forwarded to the host so the applet can say so on the session
indicator (CLAUDE.md constraint #2 — the user is never left with a stale idea of
what the agent is doing). An applet that does not know the message ignores it, so
the hold still holds.

Both transitions are audited (`session.held`, `session.resumed`). Hold grants
nothing: it can only ever *remove* the agent's ability to act, so it is not a
consent bypass in either direction.

### `agent.chat` / `host.chat` / `chat.message` — session-scoped chat (Feature Batch 2)

Real-time text chat between the technician and the customer, plus **Send URL**
as a specialised chat item. Deliberately **not** wired into the hold gate: Hold
pauses remote *actions* (input, scripts, elevation), not communication, so chat
flows in either direction whether or not the session is held.

The technician's console sends `agent.chat`; the applet sends `host.chat`
(text only — Send URL is technician→customer only, one direction, so the
customer side never composes one). Neither carries a sender identity: the
**relay** assigns `senderRole` from which socket sent it (`agent` or `host`),
never from a client-supplied field, so a sender cannot be spoofed. The relay
also assigns the canonical `id` (`"<session uuid>.<seq>"`, monotonic per
session — the pairing code no longer appears in it) and `ts` (server clock),
**stores the message in the session transcript first**, and only then echoes the same canonical `chat.message` back to the
sender as well as forwarding it to the peer — the sender's optimistic bubble
reconciles to "sent" by matching its own `clientId` (opaque, client-chosen,
only used for that reconciliation and for de-duplicating an accidental resend;
never trusted for ordering or identity).

```jsonc
// agent -> server
{ t:"agent.chat", kind:"text", text:"...", clientId:"c1" }
{ t:"agent.chat", kind:"url", url:"https://...", label?:"...", clientId:"c2" }

// host -> server
{ t:"host.chat", text:"...", clientId:"c3" }

// server -> both (canonical; echoed to sender, forwarded to peer)
{ t:"chat.message", id:"482913.7", senderRole:"agent"|"host",
  kind:"text"|"url", text?:"...", url?:"...", label?:"...",
  ts:1234567890, clientId?:"c1" }
```

Limits, enforced **server-side** (the console/applet enforce the same limits
client-side too, but the relay is the boundary that counts): text and URL
labels up to 4,000 and 200 characters respectively (`chat_too_long`); a URL up
to 2,000 characters and **`http:`/`https:` only** — parsed with `URL`, never a
regex — everything else (`javascript:`, `data:`, `file:`, `vbscript:`, a bare
custom scheme) is refused (`invalid_url`); and a per-session rate limit
(`chat_rate_limited`) against flooding. A message with the same `clientId` as
one recently sent in the same session is **not** re-forwarded to the peer — the
stored canonical ack is simply re-sent to whichever side resent it — so a naive
client-side retry after a perceived failure cannot double up in the recipient's
transcript.

**A shared URL is never opened automatically.** The customer decides whether to
click it — see CLAUDE.md's non-negotiable consent design; auto-opening a link
on the customer's machine would be exactly the kind of unconsented action this
project exists to not do.

**Audit, metadata only** (CLAUDE.md constraint #5, and see "Audit events"
below): `chat.message` records `{ senderRole, length }`, never the text itself;
`url.shared` records `{ senderRole, domain }`, never the full URL (which may
carry a query string) or the label.

### `agent.notes.save` — technician-private session notes (Feature Batch 2)

`{ t:"agent.notes.save", length:int }`. The note **text itself never crosses
this socket** — the socket the customer's applet shares a relay with. The
message exists so a save is recorded in the JSONL security log (`{ length }`,
never content).

**Persistence (admin-portal release):** the console saves the note text over the
authenticated HTTPS API, `POST /api/agent/sessions/<sessionId>/notes` (CSRF-
protected, owner only), into the durable `session_notes` table — one row per
save, so earlier revisions remain. Notes are readable by their author and by
Admin/Supervisor/Auditor roles in the admin portal (every such view is audited);
never by the customer.

### Error codes added by Feature Batch 2

| `code` | Meaning |
|---|---|
| `chat_too_long` | A chat message, URL, or label exceeded its length limit (or was empty). |
| `chat_rate_limited` | Too many chat messages from this session in the window. |
| `invalid_url` | A Send URL payload was not `http:`/`https:`, or failed to parse. |

---

## Multi-session (up to four live sessions per technician)

A technician may hold several live sessions at once — `min(users.max_concurrent_sessions,
MAX_CONCURRENT_SESSIONS_PER_AGENT)`, 4 by default. **Nothing about a session travels in a
message body.** Each session has its own technician socket, and the relay binds that
socket to exactly one session at `agent.create` (or `agent.resume`); every `agent.*`
message is routed by the socket it arrived on. There is therefore no `sessionId` field
for a client to forge, and a technician cannot address another technician's session —
or even their own other sessions — from a socket that does not belong to it.

**The limit.** `agent.create` counts the technician's live sessions — waiting for a
customer, awaiting consent, active, or inside the reconnect grace below — and refuses
at the limit:

```json
{ "t": "error", "code": "session_limit", "maxSessions": 4, "activeSessions": 4,
  "message": "Maximum concurrent session limit reached. You can manage up to 4 active sessions. Disconnect an existing session before starting another." }
```

No existing session is ended to make room. Ended, declined and expired sessions never
count (they have left the relay's live map). The count and the reservation run in one
synchronous turn of the relay's event loop, so two simultaneous creates can never both
become the fourth. (One relay process per database, as the admin-portal release already
requires.)

**Technician reconnect.** If a technician socket closes *without* `agent.end`, the
session is not ended: it keeps its slot for `AGENT_RECONNECT_GRACE_MS` (60 s). The
customer's side is untouched and sees nothing; while no technician is attached nothing
can be sent to their machine, and frames only update the relay's catch-up buffer. If the
grace runs out the session ends as `agent_disconnected`, exactly as before. A new
technician socket resumes it with:

```json
{ "t": "agent.resume", "sessionId": "<uuid>", "resumeToken": "<from session.created or the last session.resumed>" }
```

All three are required: a signed-in technician on the socket, who **owns** the session
(same org, same user), presenting the session's **current** resume token. The token is
32 random bytes, stored by the relay only as a SHA-256 hash, compared in constant time,
redacted from the audit log, and **rotated on every resume**. Any failure is the same
`resume_failed` error and a close — a probe learns nothing. If the old socket is somehow
still open (a half-dead connection, a second window), the verified owner takes over and
the old socket is closed with `4409`. Resumes are rate-limited per technician
(`RESUME_ATTEMPTS_PER_MINUTE`); a limited one gets `rate_limited` and a `4429` close,
which — unlike `resume_failed` — means "try again shortly", not "this session is gone".
On success:

| Server → agent | |
|---|---|
| `{ t:"session.resumed", sessionId, resumeToken, state, code?, host, held, elevated, desktop, createdAt, consentedAt, reconnectCount }` | The new token replaces the old one. `code` only while still waiting for a customer. |
| binary frames | The catch-up buffer: the last keyframe, then every dirty rectangle since, in order — an exact current picture. |
| `{ t:"chat.history", messages:[chat.message…] }` | The stored transcript, including anything the customer sent while the technician was away. De-duplicate by `id`. |

The timeline records `agent.reconnecting`, `agent.reconnected` and, if the grace runs
out, `agent.reconnect_expired`; `sessions.reconnect_count` and `last_disconnect_reason`
are kept on the record.

**Video priority.** `agent.view { priority: "preview" }` — sent by the console for every
session that is not the selected one — makes the relay forward **keyframes only**. The
applet sends one at least every 5 s (`ScreenStreamer.KeyframeInterval`), so background
sessions stay a live thumbnail at a fraction of the bandwidth and decode cost. The relay
meanwhile keeps the last keyframe and the dirty rectangles since (bounded at 3 MB per
session; past that, the keyframe alone); `priority: "full"` replays them before live frames
resume, so switching back is instant and exact. The applet is unchanged and unaware.

**Why none of this is in `windows/Shared/Protocol.cs`:** every message in this section
is between the relay and the technician console. The applet never sends or receives any
of them, and the verified Windows build stays byte-identical.

## Session lifecycle phase, health (Technician Platform 2.0, Phase 1)

The relay's `state` above is unchanged and still drives the consent gate and every relay
rule. On top of it each session has one validated **phase** (`server/src/lifecycle.ts`):

```
CREATED → WAITING → CONSENT_PENDING → CONNECTED → CONTROLLING
                                          ▲  │ ▲        │
                                          │  ▼ │        ▼
                                          └─ ON_HOLD ◄──┘
any live phase → RECONNECTING (technician socket lost) → back to the phase it interrupted
terminal: ENDED · EXPIRED (code unused) · DECLINED (consent refused) · FAILED (record not written)
```

`CONTROLLING` is entered by the first `agent.input` after `CONNECTED` (after consent, a
resume, or un-holding) — once, not per event. While `RECONNECTING`, changes on the
customer's side (join, consent) move the phase the session will return to. Every change
is validated against the transition table; an invalid one is refused, logged and audited
(`session.invalid_transition`). No client message names a phase, so only a relay bug
could produce one. Each change is a `session.phase` timeline row (`{from, to}`, with its
timestamp) and `sessions.phase` / `phase_changed_at` on the record.

| Server → agent (technician only — the applet never sees these) | |
|---|---|
| `session.created` gains `expiresAt` (epoch ms the unused code expires), `expiresInMs` (the same, as a duration — immune to console clock skew) and `phase` (`"WAITING"`) | Drives the New Session countdown. |
| `session.resumed` gains `phase`, `phaseSince`, and `expiresAt` / `expiresInMs` alongside `code` | |
| `peer.joined` (role host) and `consent.result` (accepted) gain `phase` | The phase rides on the message that already marks the moment, so a client that reads messages in order sees exactly the sequence it always did. |
| `{ t:"session.phase", phase, since }` | Every other visible change (CONTROLLING, ON_HOLD / back to CONNECTED, and the terminal phase) — always **after** any pre-existing message for the same event and before the socket closes. |
| `{ t:"session.health", hostRttMs, agentRttMs }` | Every 5 s while active. Round trips measured by the relay with stamped WebSocket pings on each leg (`[0x52][f64 BE epoch ms]`); every WebSocket client answers a ping, so the applet is unchanged. `null` until the first measurement. |

Not in `windows/Shared/Protocol.cs`, for the same reason as the multi-session section.

## Phase 2b — files, clipboard, system information, script cancel (Technician Platform 2.0)

Relay half: `server/src/features.ts`. Applet half: `windows/Applet/Features/*`, records in
`windows/Shared/ProtocolFeatures.cs`. **All JSON on the existing control channel** — file data
travels as base64 chunks; the binary video framing above is unchanged.

**Negotiation.** `host.join` gains `protocolVersion: 2` and `capabilities: ["files",
"clipboard","sysinfo","execCancel"]`. An applet without them is version 1 with no
capabilities; the relay forwards `capabilities`/`protocolVersion` to the console on
`peer.joined` (and `capabilities` on `session.resumed`), and refuses any feature message the
applet did not declare with `error not_supported` — it is never forwarded, so it cannot hang.

**Authorisation (relay).** Files (browse, upload, download, create, rename, delete) need the
technician's `allowFileTransfer` limit (`users.allow_file_transfer`, default on) →
`not_permitted`. Starting anything is refused while held (`session_held`); continuing or
cancelling a running transfer, and stopping a script, is not.

| Agent → host | Host → agent | |
|---|---|---|
| `agent.fs.list {rid, path}` (`""` = drives and known folders) | `host.fs.result {rid, op:"list", ok, path, parent, entries:[{name,type,size?,modified?,path?}], truncated?, error?}` | |
| `agent.fs.mkdir {rid, path}` · `agent.fs.rename {rid, path, newName}` · `agent.fs.delete {rid, path}` | `host.fs.result {rid, op, ok, path, newName?, error?}` | rename stays in its folder; delete = file or EMPTY folder |
| `agent.file.put {tid, name, size, dir?}` | `host.file.ready {tid, path}` | upload; `dir` empty → `Downloads\Helpdesk Anywhere` |
| `agent.file.chunk {tid, seq, data}` | `host.file.ack {tid, seq}` | ≤ 48 KiB per chunk, seq from 1, ≤ 8 unacked |
| `agent.file.end {tid, sha256?}` | `host.file.done {tid, bytes, sha256, path}` | applet verifies size + hash, then renames from `.hdapart` |
| `agent.file.get {tid, path}` | `host.file.meta {tid, name, size}` → `host.file.chunk {tid, seq, data}`… → `host.file.done {tid, bytes, sha256}` | download; console acks each chunk with `agent.file.ack {tid, seq}` |
| `agent.file.cancel {tid}` | `host.file.error {tid, error}` (failure on either side) | |
| `agent.clipboard.set {rid, text}` · `agent.clipboard.get {rid}` | `host.clipboard.result {rid, op, ok, text?, truncated?, error?}` | text only, ≤ 60 000 chars |
| `agent.sysinfo.get {rid}` | `host.sysinfo {rid, info}` | collected on request only |
| `agent.exec.cancel {id}` | the script's normal final `host.execResult`, marked `[stopped by the technician]` | user-level scripts only |

**Relay accounting, per transfer** (`tid` a UUID): declared size ≤ `MAX_FILE_TRANSFER_BYTES`
(1 GiB); at most `MAX_TRANSFERS_PER_SESSION` (3) at once; chunks strictly in sequence; bytes
never beyond the declared size; `end`/`done` only when bytes = size. Any breach stops the
transfer and tells the applet `agent.file.cancel`. A technician drop (reconnect grace) or the
session's end cancels everything in flight.

**Records.** `file_transfers` row per transfer (direction, name, remote path, size, bytes,
status, error, SHA-256, technician, times); timeline `file.transfer`, `fs.changed`,
`clipboard.sent` / `clipboard.read` (length only), `sysinfo.collected`, `script.cancelled`;
JSONL `file.transfer`, `fs.list`, `fs.changed`, `clipboard.sent`, `clipboard.read`,
`exec.cancel`. **File contents and clipboard text are never stored or logged** (`ws/14`).

## Phase 3 — customer-side reconnect (Technician Platform 2.0)

Capability `resume` (in `host.join capabilities`). Details and rationale: `docs/reconnect.md`.

| Message | Direction | |
|---|---|---|
| `{ t:"host.resumeToken", sessionId, resumeToken }` | relay → applet, once, right after consent | only to an applet that declared `resume`; never sent to the technician |
| `{ t:"host.resume", sessionId, resumeToken }` | applet → relay, FIRST message on a new socket | within `HOST_RECONNECT_GRACE_MS`; rate-limited per IP |
| `{ t:"host.resumed", resumeToken, held }` | relay → applet | token rotated; the old one is dead |
| `error customer_reconnecting` | relay → technician | for any deliberate action while the customer is away (input is dropped silently) |

The technician sees `session.phase DISCONNECTED`, then `CONNECTED` / `ON_HOLD` on return, or the
session ends `customer_disconnected` when the grace runs out.

## Host (applet) → server

| Message | Notes |
|---|---|
| `{ t:"host.join", code:"482913", machine:"...", user:"...", os:"..." }` | Rate-limited to 5 attempts per IP per minute. |
| `{ t:"host.consent", accepted:bool }` | Nothing streams before `accepted:true`. |
| `{ t:"host.desktopChanged", desktop:"Default"\|"Winlogon"\|"Screen-saver" }` | Phase 5.6 — drives the "UAC prompt active" banner. |
| `{ t:"host.elevated", ok:bool, error?:"..." }` | Phase 5. `error` is a mapped message, never a raw credential. |
| `{ t:"host.execResult", id:"...", exitCode:int, stdout:"...", stderr:"...", partial?:bool }` | Phase 6. See below. |
| `{ t:"host.chat", text:"...", clientId:"..." }` | Feature Batch 2. See "agent.chat / host.chat / chat.message" above. |

### `host.execResult` streaming (Phase 6.1)

Long-running scripts must be watchable, so output streams as it arrives rather than
only on exit. The same message carries both:

- **`partial: true`** — an incremental chunk. `exitCode` is `-1` and carries no
  meaning; `stdout`/`stderr` hold only what arrived since the previous chunk. Any
  number of these may be sent, and the server does **not** audit them.
- **`partial` absent or `false`** — the final result. `exitCode` is real, and the
  server writes the `exec.result` audit record. Exactly one is sent per `id`.

Output is capped at 1 MB per execution; past that the applet stops appending and says
so in the final `stderr`.

### Binary frames (host → agent)

```
[0x01][jpeg bytes]                                   full frame
[0x02][x:u16][y:u16][w:u16][h:u16][jpeg bytes]       dirty rect (Phase 3.3)
```

All integers are **big-endian**. A full keyframe is sent every 5s, on any client
resize, and immediately on a desktop switch (Phase 5.6).

The same `[0x01]`/`[0x02]` payload framing is reused over the named pipe between
`DesktopHelper` and `Applet` (PLAN 5.5) so the applet can forward without re-encoding.

---

## Server → both

| Message | Direction | Notes |
|---|---|---|
| `{ t:"session.created", code:"482913", sessionId:"<uuid>", resumeToken:"..." }` | → agent | `code` is the short-lived pairing secret; `sessionId` the permanent record id; `resumeToken` the per-session secret for `agent.resume` (multi-session). |
| `{ t:"session.resumed", ... }` / `{ t:"chat.history", ... }` | → agent | Multi-session: the answer to `agent.resume`. See "Multi-session". |
| `{ t:"host.connectRequest", agentName:"..." }` | → host | Drives the consent dialog. `agentName` is the owning technician's **verified Entra display name**, fixed at `agent.create`; nothing a browser sends can change it. |
| `{ t:"consent.result", accepted:bool }` | → agent | |
| `{ t:"peer.joined", role:"agent"\|"host", info?:{...} }` | → both | |
| `{ t:"peer.left", role:"agent"\|"host" }` | → both | |
| `{ t:"chat.message", ... }` | → both | Feature Batch 2. See "agent.chat / host.chat / chat.message" above. |
| `{ t:"error", code:"...", message:"...", clientId?:"..." }` | → either | See error codes below. `clientId` is present only for a refused `agent.chat`/`host.chat` (`chat_too_long`, `chat_rate_limited`, `invalid_url`), echoing the sender's own id back so its UI can mark that specific pending message failed. |

### Error codes

| `code` | Meaning |
|---|---|
| `bad_code` | No such session, or the code has already been used. |
| `code_expired` | Session code TTL elapsed. |
| `rate_limited` | Too many `host.join` attempts from this IP. |
| `not_active` | Frame sent before consent completed. |
| `insecure_transport` | Credential-mode elevation attempted while either the technician's or the customer's connection is not `wss:`. |
| `elevation_rate_limited` | More than 5 elevation attempts in one session. |
| `session_held` | A script or elevation was attempted while the session is on hold. |
| `chat_too_long` | Feature Batch 2. A chat message, URL, or label exceeded its length limit. |
| `chat_rate_limited` | Feature Batch 2. Too many chat messages from this session in the window. |
| `invalid_url` | Feature Batch 2. A Send URL payload was not `http:`/`https:`. |
| `protocol` | Malformed or out-of-order message. |
| `unauthorized` | Admin-portal release. `agent.create` from a socket with no signed-in technician (or one whose role/limits do not allow the console). The socket is closed. |
| `not_permitted` | A script or elevation from an account whose per-user limits forbid it. |
| `session_limit` | The technician already has their maximum number of concurrent sessions. Carries `maxSessions` and `activeSessions`. |
| `resume_failed` | Multi-session. `agent.resume` refused (unknown or ended session, not the owner, wrong or stale token), or — sent to the OLD socket — the session was resumed in another window. The socket is closed. |
| `storage_unavailable` | The session could not be recorded (`agent.create`), or a script's audit record could not be written (`agent.exec` — the script is not run). |
| `chat_not_saved` | The chat message could not be stored, so it was **not delivered**; carries `clientId`. A retry with the same `clientId` is safe. |
| `access_revoked` | The technician was suspended, their sign-in expired, or an administrator ended the session. |

The admin-portal additions (`sessionId`, the verified `agentName`, the codes
above) all travel between the relay and the **technician console**. The applet
receives none of the new fields or codes, so `windows/Shared/Protocol.cs` is
deliberately unchanged by this release — the applet's wire contract is exactly
the one verified on real Windows.

## Identity on the socket (admin-portal release)

The WebSocket upgrade itself is authorised: a **browser** upgrade (one that
sends `Origin`) must carry the technician console's session cookie, or it is
refused `401`; a foreign `Origin` is refused `403`. An upgrade with no `Origin`
— the applet — is anonymous and can only ever send `host.join`. The identity is
bound to the socket at upgrade and re-checked on every `agent.*` message: a
suspension closes the socket immediately, and an expired sign-in ends the
session. The admin portal is a separate application with no WebSocket at all.

---

## Credential handling — mandatory (CLAUDE.md constraint #6, PLAN 5.2c)

The `password` field of `agent.requestElevation` is the most security-sensitive value on
this wire.

1. **Refuse `mode:"credential"` outright over a non-`wss:` connection** → `error`
   with `code:"insecure_transport"`. **Both legs count** (security audit
   2026-10-05, F-02): the password crosses the technician's connection and then
   the customer's, so the relay refuses unless both arrived over TLS.
2. **Never logged, anywhere** — not the audit log, not server logs, not `console.log`,
   not exception messages or stack traces. Audit the *fact*, *result* and *username* of
   an elevation attempt; never the password. The server's message logger has an explicit
   redaction step keyed on this message type so a future verbose-logging change cannot
   leak it by accident.
3. **The relay retains nothing** — forwarded in memory only, never buffered, queued or
   persisted. *Known POC limitation:* the relay can see the plaintext. Past a POC this
   payload should be end-to-end encrypted to a key the applet generates at session start.
4. **Zeroed after use** on the applet side, and never retained for later re-elevation.
5. **Surfaced to the end user** on the session indicator.
6. **Rate-limited** to 5 attempts per session; every failure is audited.
