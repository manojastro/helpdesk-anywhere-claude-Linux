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
| `{ t:"agent.create" }` | → `{ t:"session.created", code:"482913" }` |
| `{ t:"agent.input", kind:"mouse"\|"key", ... }` | Phase 4. Relayed to host. |
| `{ t:"agent.exec", id:"...", shell:"powershell"\|"cmd", script:"...", asSystem:bool }` | Phase 6. Audited with full script text **before** the process starts. |
| `{ t:"agent.requestElevation", mode:"interactive" }` | Phase 5.2a — end user is a local admin; Windows shows its native consent prompt. |
| `{ t:"agent.requestElevation", mode:"credential", domain, username, password }` | Phase 5.2b. **`password` is NEVER logged** — see below. |
| `{ t:"agent.end" }` | Tears down both sides. |

### `agent.input` payloads (Phase 4)

```jsonc
{ t:"agent.input", kind:"mouse", x:1234, y:567,
  button:0|1|2|null, action:"move"|"down"|"up"|"wheel", wheelDelta?:-120 }

{ t:"agent.input", kind:"key", code:"KeyA", action:"down"|"up" }
```

`x`/`y` are **remote pixels** in virtual-desktop space, mapped by the console from the
canvas backing store (not the CSS size). `code` is the DOM `event.code` (physical key),
not `event.key`, so keyboard layout differences do not scramble input.

---

## Host (applet) → server

| Message | Notes |
|---|---|
| `{ t:"host.join", code:"482913", machine:"...", user:"...", os:"..." }` | Rate-limited to 5 attempts per IP per minute. |
| `{ t:"host.consent", accepted:bool }` | Nothing streams before `accepted:true`. |
| `{ t:"host.desktopChanged", desktop:"Default"\|"Winlogon"\|"Screen-saver" }` | Phase 5.6 — drives the "UAC prompt active" banner. |
| `{ t:"host.elevated", ok:bool, error?:"..." }` | Phase 5. `error` is a mapped message, never a raw credential. |
| `{ t:"host.execResult", id:"...", exitCode:int, stdout:"...", stderr:"..." }` | Phase 6. Partial output may stream before the final result. |

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
| `{ t:"session.created", code:"482913" }` | → agent | |
| `{ t:"host.connectRequest", agentName:"..." }` | → host | Drives the consent dialog. |
| `{ t:"consent.result", accepted:bool }` | → agent | |
| `{ t:"peer.joined", role:"agent"\|"host", info?:{...} }` | → both | |
| `{ t:"peer.left", role:"agent"\|"host" }` | → both | |
| `{ t:"error", code:"...", message:"..." }` | → either | See error codes below. |

### Error codes

| `code` | Meaning |
|---|---|
| `bad_code` | No such session, or the code has already been used. |
| `code_expired` | Session code TTL elapsed. |
| `rate_limited` | Too many `host.join` attempts from this IP. |
| `not_active` | Frame sent before consent completed. |
| `insecure_transport` | Credential-mode elevation attempted over a non-`wss:` connection. |
| `elevation_rate_limited` | More than 5 elevation attempts in one session. |
| `protocol` | Malformed or out-of-order message. |

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
