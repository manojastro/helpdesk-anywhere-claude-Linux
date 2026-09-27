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
| `{ t:"agent.create" }` | → `{ t:"session.created", code:"482913", sessionId:"<uuid>" }`. **Requires a signed-in technician** (admin-portal release, see "Identity on the socket"). |
| `{ t:"agent.input", kind:"mouse"\|"key"\|"sas", ... }` | Phase 4. Relayed to host. |
| `{ t:"agent.exec", id:"...", shell:"powershell"\|"cmd", script:"...", asSystem:bool }` | Phase 6. Audited with full script text **before** the process starts. |
| `{ t:"agent.requestElevation", mode:"interactive" }` | Phase 5.2a — end user is a local admin; Windows shows its native consent prompt. |
| `{ t:"agent.requestElevation", mode:"credential", domain, username, password }` | Phase 5.2b. **`password` is NEVER logged** — see below. |
| `{ t:"agent.hold", held:bool }` | Feature Batch 1. Pauses/resumes technician control. See below. |
| `{ t:"agent.chat", kind:"text", text:"...", clientId:"..." }` | Feature Batch 2. Plain-text chat. See below. |
| `{ t:"agent.chat", kind:"url", url:"...", label?:"...", clientId:"..." }` | Feature Batch 2. Send URL — a specialised chat item. |
| `{ t:"agent.notes.save", length:int }` | Feature Batch 2. Technician-private notes. See below. |
| `{ t:"agent.end" }` | Tears down both sides. |

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
| `{ t:"session.created", code:"482913", sessionId:"<uuid>" }` | → agent | `code` is the short-lived pairing secret; `sessionId` the permanent record id. |
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
| `insecure_transport` | Credential-mode elevation attempted over a non-`wss:` connection. |
| `elevation_rate_limited` | More than 5 elevation attempts in one session. |
| `session_held` | A script or elevation was attempted while the session is on hold. |
| `chat_too_long` | Feature Batch 2. A chat message, URL, or label exceeded its length limit. |
| `chat_rate_limited` | Feature Batch 2. Too many chat messages from this session in the window. |
| `invalid_url` | Feature Batch 2. A Send URL payload was not `http:`/`https:`. |
| `protocol` | Malformed or out-of-order message. |
| `unauthorized` | Admin-portal release. `agent.create` from a socket with no signed-in technician (or one whose role/limits do not allow the console). The socket is closed. |
| `not_permitted` | A script or elevation from an account whose per-user limits forbid it. |
| `session_limit` | The technician already has their maximum number of concurrent sessions. |
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
   with `code:"insecure_transport"`.
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
