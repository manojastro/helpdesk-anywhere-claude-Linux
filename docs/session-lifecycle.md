# Session lifecycle

Technician Platform 2.0, Phase 1. Code: `server/src/lifecycle.ts` (the table),
`server/src/signaling.ts` `setPhase()` (the only caller), `server/migrations/003_session_phase.sql`.

## Two layers, on purpose

| Layer | Values | Who uses it |
|---|---|---|
| Relay **state** (unchanged) | `waiting_for_host`, `waiting_for_consent`, `active`, `ended` | The consent gate and every relay rule. Untouched by 2.0, so nothing the verified Windows flow depends on moved. |
| Lifecycle **phase** (new) | see below | The console, the dashboard, the admin portal, reports. One validated answer to "where is this session?" |

`sessions.status` in PostgreSQL keeps the old four values, so every existing query,
report and test is unaffected. `sessions.phase` / `phase_changed_at` carry the new one.

## Phases

```
CREATED ──► WAITING ──► CONSENT_PENDING ──► CONNECTED ──► CONTROLLING
                                                ▲  │ ▲          │
                                                │  ▼ │          ▼
                                                └─ ON_HOLD ◄────┘

any live phase ──► RECONNECTING ──► (back to the phase it interrupted)     technician away
CONNECTED/CONTROLLING/ON_HOLD ──► DISCONNECTED ──► CONNECTED | ON_HOLD       customer away (Phase 3)

terminal:  ENDED · EXPIRED · DECLINED · FAILED
```

| Phase | Entered when |
|---|---|
| `CREATED` | `agent.create` accepted, record not yet written |
| `WAITING` | record written, PIN issued |
| `CONSENT_PENDING` | the applet joined with the PIN; consent prompt shown |
| `CONNECTED` | customer accepted; also after un-holding or a technician resume |
| `CONTROLLING` | first `agent.input` while `CONNECTED` — once, not per event |
| `ON_HOLD` | technician pressed Hold (relay-enforced, as before) |
| `RECONNECTING` | technician socket dropped without `agent.end`; 60 s grace |
| `DISCONNECTED` | the customer's applet lost its connection; 60 s grace for it to resume (`docs/reconnect.md`) |
| `ENDED` | any normal end (technician, customer, drop, admin, revocation, shutdown) |
| `EXPIRED` | PIN unused for its TTL (10 min) |
| `DECLINED` | customer refused consent |
| `FAILED` | the session record could not be written |

The full allowed-transition table is `TRANSITIONS` in `lifecycle.ts`;
`tests/unit/40-lifecycle.mjs` checks every row and a set of forbidden moves.

## Rules

1. **Validated server-side.** `setPhase()` checks the table. An invalid move is refused
   (phase unchanged), logged as `[lifecycle] refused A -> B`, and audited as
   `session.invalid_transition`. No client message names a phase, so only a relay bug
   could cause one; `ws/12` asserts none happens across a full session.
2. **Timestamped and recorded.** Every change is a `session.phase` row in
   `session_events` (`{from, to}`, `at`), in order with the rest of the timeline, and
   updates `sessions.phase` / `phase_changed_at`.
3. **Reflected in the UI.** The relay sends `session.phase` to the owning console;
   `session.created` and `session.resumed` carry the phase too.
4. **Reconnecting remembers.** While the technician is away, things on the customer's
   side (join, consent, decline, PIN expiry) still happen. Non-terminal ones move the
   *remembered* phase (validated against the same table; recorded with
   `deferred: true`); terminal ones end the session. On resume the session returns to
   the remembered phase. `CONTROLLING` resumes as `CONNECTED`.

## Not used (yet)

* `CONNECTING` — the relay sends the consent prompt in the same turn as the applet's
  join, so there is no observable gap.
* `TRANSFERRED` — session transfer (Phase 5).
* `RESTART_REQUESTED` — remote reboot is out of scope (`DECISIONS.md` D-018).

Adding one is a row in `TRANSITIONS`, a label, and the migration's CHECK constraint.

## Rollback

Forward-only migration; manual reversal is in the header of `003_session_phase.sql`.
Reverting the code without reverting the migration is safe: the extra columns have
defaults and nothing else reads them.
