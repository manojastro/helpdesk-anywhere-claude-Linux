/** PLAN 1.2: codes expire after 10 min unused. Run with SESSION_CODE_TTL_MS=1500. */
import { open, send, waitFor, check, report, sleep } from "../lib/harness.mjs";

console.log("\n=== Phase 1 acceptance — code expiry (SESSION_CODE_TTL_MS=1500) ===\n");
console.log("[7] An unused code expires and can no longer be claimed");

const agent = await open();
send(agent, { t: "agent.create" });
const created = await waitFor(agent, (m) => m.t === "session.created");
check("session created", !!created, `code=${created?.code}`);

const early = await open();
send(early, { t: "host.join", code: created.code, machine: "M", user: "u", os: "o" });
const ok = await waitFor(early, (m) => m.t === "host.connectRequest");
check("code is claimable before the TTL elapses", !!ok);
early.close();
agent.close();
await sleep(300);

// Now a fresh code, left to expire.
const agent2 = await open();
send(agent2, { t: "agent.create" });
const c2 = await waitFor(agent2, (m) => m.t === "session.created");
console.log(`  waiting 2.2s for code ${c2.code} to pass its 1.5s TTL…`);
await sleep(2200);

const late = await open();
send(late, { t: "host.join", code: c2.code, machine: "M", user: "u", os: "o" });
const err = await waitFor(late, (m) => m.t === "error");
check("expired code → error code_expired", err?.code === "code_expired", JSON.stringify(err));
check("expired code yields no connectRequest",
  !late.received.find((m) => m.t === "host.connectRequest"));
late.close();
agent2.close();

await sleep(100);
report("expiry block");
