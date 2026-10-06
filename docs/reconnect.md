# Reconnect

Technician Platform 2.0. Two independent kinds of recovery; **no reboot recovery**
(`DECISIONS.md` D-018 — nothing in the product survives a restart of the customer's PC).

| Who dropped | Since | Grace | Proof to come back | Phase while away |
|---|---|---|---|---|
| Technician (browser, Wi-Fi, reload) | multi-session release | `AGENT_RECONNECT_GRACE_MS` 60 s | signed-in owner + rotating 256-bit resume token | `RECONNECTING` |
| Customer (applet's network) | Phase 3 | `HOST_RECONNECT_GRACE_MS` 60 s | rotating 256-bit host resume token, issued to that applet at consent | `DISCONNECTED` |

Both can be away at once; the lifecycle remembers (`docs/session-lifecycle.md`).

## Customer side

1. At consent, an applet that declared capability `resume` receives
   `host.resumeToken {sessionId, resumeToken}`. It stays inside `SessionClient` (never posted to
   the UI, never logged; the C# records redact it). Older applets get nothing and behave as before.
2. If the socket fails underneath a live session — **not** a Close from the relay, and not the
   customer's End Session — the SAME `SessionClient` redials with backoff (1, 2, 4, 8, 8 … s) for up
   to 55 s and sends `host.resume {sessionId, resumeToken}` as its first message. The streamer,
   script runner and feature host keep their sink; nothing in the capture or input path is involved.
3. The relay keeps the session for 60 s. Meanwhile input is dropped silently, any deliberate action
   (script, elevation, chat, file, clipboard) is refused with `customer_reconnecting`, and transfers in
   flight are cancelled. The technician sees "Customer reconnecting…".
4. A matching token rebinds the socket, rotates the token (`host.resumed {resumeToken, held}`), and the
   phase returns to CONNECTED or ON_HOLD. Consent is not asked again: the applet process, its
   always-visible indicator and its End Session button never went away, and the indicator said
   "Connection lost — reconnecting…" throughout.
5. If the grace runs out, the session ends as `customer_disconnected`; the applet stops trying at 55 s
   and ends the same way.

Security: the token is per session, stored only as a SHA-256, compared in constant time, rotated on
every use, and useless once the session ends; `host.resume` is rate-limited per IP (20/min); all
refusals are the same `resume_failed`. A stale socket the relay had not yet noticed is replaced (4409).

Records: timeline `customer.reconnecting` / `customer.reconnected` / `customer.reconnect_expired`,
`sessions.host_reconnect_count`, JSONL `session.host_reconnecting` / `session.host_resumed`.

## Tests

`ws/15` (relay: token issue, wrong/other/rotated token, actions refused, hold kept, no grace for
old applets / End Session / ended sessions, rate limit, records), `ws/15b` (grace expiry),
`dotnet/ReconnectTests` (**the applet's real `SessionClient` against the real relay on Linux**:
cut the line, it comes back on the same session, token rotated, traffic flows, a relay-side end is
final), `browser/45` §7 (console), `source/45` §8.
