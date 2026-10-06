# Technician console

`server/public/portal.{html,css,js}`, `dashboard.js`, `identity.js`. One page, one
browser tab, up to four sessions (see `docs/MULTI_SESSION.md` for the session model,
isolation and resource use).

## Layout

```
┌ header ─ brand · status pill · PIN · duration · device · HDA-ref · Elevated ─ technician ┐
├ toolbar ─ New · Resume · Hold · End │ Fullscreen · − Fit + · Magnifier │ tools │ support ┤
├ strip ─ Dashboard · [session tabs …] + · Active Sessions n / 4 · Tabs/Grid · Disconnect all ┤
├ left: current session, events │ REMOTE SCREEN │ right: Tools/Scripts/Chat/Notes/Info ─────┤
└ status bar ─ state · FPS · Bitrate · Resolution · Connection · Latency · Input · UAC/Hold ─┘
```

The remote screen stays the largest element at every supported size; side panels
collapse to rails below 1280 / 1100 px.

## Phase 1 additions (Technician Platform 2.0)

| Feature | Where | Data source |
|---|---|---|
| Idle dashboard | over the empty viewport, only while no session exists | this console's sessions + `GET /api/agent/dashboard` |
| Dashboard dialog | strip → **Dashboard** | same; queue rows switch session on click |
| Cards | Active · Waiting · Reconnecting · Completed today | live counts local; "completed today" = sessions that connected and ended since the technician's local midnight |
| Search / filter | dashboard → Recent sessions | device, user or exact session id; result (Completed / Declined / Expired / Failed) — server-side, own sessions only |
| New Session card | shown while a PIN is waiting | PIN in two groups, **Expires in mm:ss** (relay TTL, skew-free), Copy PIN / Link / Invitation |
| Workspace header | header chips | device · OS, `HDA-xxxxxxxx` (first 8 of the session UUID), Elevated |
| Connection health | status bar, Info tab | `session.health`: relay-measured round trips, both legs summed. Excellent < 100 ms · Good < 200 · Fair < 400 · Poor ≥ 400 or no report for 15 s · Reconnecting · Offline |
| Zoom − / + | toolbar | steps through the same levels as the zoom list; + from Fit = 100 % |
| Lifecycle phase | Info tab | `session.phase` (`docs/session-lifecycle.md`) |

### What the console does not invent

* Health shows **Measuring…** until the relay has measured both legs; FPS and bitrate are
  counted from frames actually received. Nothing is estimated.
* Monitor selection and stream quality are visible as **planned** (disabled) — they need
  applet changes and are scheduled with care around the golden capture code
  (`docs/golden-features.md`).
* Reboot was removed from the toolbar: remote restart is out of scope (D-018).

### Invitation text

```
<Technician name> from the helpdesk is ready to assist you.

Support PIN: 482915

Open:
https://<host>/j/482915

Download and run the Helpdesk Anywhere app from that page, enter the PIN, and accept the prompt. The PIN works once.
```

It carries only the PIN and the join link — never the session id or resume token.

## Phase 2 additions (server and console)

| Feature | Where | Notes |
|---|---|---|
| Activity | inspector → **Activity** | the selected session's server-recorded timeline (`GET /api/agent/sessions/:id/events`), refreshed every 5 s while open; lifecycle bookkeeping hidden |
| Saved scripts | inspector → Scripts → *Saved scripts* | grouped by category; loading fills editor, shell and *Run as SYSTEM*; see `docs/script-library.md` |
| Script status | under Run Script | *Running… n s* → *Finished · exit code n · 2.4 s* (or *Stopped — timed out*); per session |
| Screenshot | toolbar camera button | PNG of the selected session's current picture, downloaded to **this computer only** (`HDA-xxxxxxxx_<machine>_<time>.png`); the server records only that one was taken (timeline `screenshot.taken` + security log) |
| Chat system lines | chat log | "remote control started", "session reconnected", "elevated", "on hold", "screenshot captured" — shown to the technician only, never sent or stored as chat |
| System | inspector → **System** (was Info) | the remote machine's name, user, OS, privilege, desktop, resolution — what the applet reports today; hardware/disk/network details need the Phase 2b applet update |

Everything here is per session: library pick, status line, activity, system lines and
drafts follow the selected session and never cross (`browser/43`).

## API used by the console

| Endpoint | |
|---|---|
| `GET /api/agent/me` | identity, limits, CSRF token |
| `GET /api/agent/sessions/live` | own live sessions (+ `phase`, `phaseSince`, `hostRttMs`) |
| `GET /api/agent/dashboard?since&q&phase` | `{counts:{active,waiting,reconnecting,onHold,completedToday}, live, maxSessions, recent:[…]}` — pinned to the signed-in technician |
| `GET/POST /api/agent/sessions/:id/notes` | private notes |
| `GET /api/agent/scripts` | saved script library |
| `GET /api/agent/sessions/:id/events` | activity timeline (own sessions) |
| `POST /api/agent/sessions/:id/screenshot` | record that a screenshot was taken (no image) |

WebSocket messages are in `shared/protocol.md`.

## Tests

`browser/17` (shell and layout), `browser/26` (multi-session), `browser/41` (Phase 1
features), `ws/12` (lifecycle, health and dashboard API at the relay).
