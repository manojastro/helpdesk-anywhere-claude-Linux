# Session transfer (and collaboration groundwork)

Technician Platform 2.0, Phase 5. Wire format: `shared/protocol.md` → "Phase 5". Decision:
`DECISIONS.md` D-020.

## Flow

```
A (owner)            relay                      B (receiver, lobby)      Customer (applet)
offer(B, note) ───►  checks: B online, same org,
                     free slot, applet has "transfer"
                     ── transfer.offer ─────────► Accept / Decline (60 s)
                     ◄──────────── accept ──────
                     ── host.transferRequest ─────────────────────────► "A wants to hand this
                                                                          session to B" (120 s)
A keeps control  ◄── transfer.status awaiting_customer                    Keep A | Accept
                     ◄──────────────────────────────────── transferConsent(accepted)
transfer.status completed; A's socket closed 4410
                     owner := B (record + live session)
                     ── transfer.ready(token) ──► B resumes the session (agent.resume)
                                                                          indicator: "shared with B"
```

* **Nothing moves until the customer says yes.** The consent dialog is the same one as at the
  start of the session, naming the new technician and the one handing over; its safe default
  keeps the current technician.
* **One controller at a time.** A keeps full control until completion; after it, A's socket is
  closed and cannot be resumed (A is no longer the owner, and the token B received was issued
  for B alone, on B's own lobby socket).
* **Slots.** The session counts against B's limit from completion; B's slot is checked at offer,
  at accept and again at completion.
* **If B never connects**, the session waits exactly as if its technician had dropped
  (`RECONNECTING`, 60 s), then ends.
* **History.** `session_transfers` keeps every attempt and how it ended; the session record names
  the last owner; timeline `transfer.offered / accepted / declined / completed / cancelled`; JSONL
  `session.transfer` and a `session.consent` record with `transfer: true`. A technician who handed a
  session over can still **read** it (dashboard history shows "Transferred to …", activity, notes)
  but no longer write its notes.
* **Off switch:** `ENABLE_SESSION_TRANSFER=false` — the relay refuses, the console hides it.

## Collaboration groundwork — not built, by design

Several technicians *controlling* one session at once is out of scope until an ownership
model exists. What this phase deliberately leaves in place for it:

* the **lobby socket** (a per-technician channel independent of sessions) — the obvious carrier
  for "invite a colleague to watch";
* **one owner per session** at the relay (`agentUserId`) with every action checked against that
  socket — a future "observer" role would be a second, input-less socket kind, never a second owner;
* the **customer-consent step for a new person** — any future invite must reuse it, because the
  customer agreed to be helped by named people, not by whoever is invited.

Before multi-technician input: decide an explicit control token (who may send input right now),
how it is requested and released, and how the customer sees who holds it.
