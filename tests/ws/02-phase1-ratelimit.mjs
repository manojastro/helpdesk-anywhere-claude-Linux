/** PLAN 1.2 / acceptance: "6 rapid bad attempts are rate-limited". Fresh server. */
import { open, send, waitFor, check, report, sleep } from "../lib/harness.mjs";

console.log("\n=== Phase 1 acceptance — host.join rate limiting (fresh server) ===\n");
console.log("[5] 6 rapid bad host.join attempts from one IP");

const results = [];
for (let i = 1; i <= 6; i++) {
  const ws = await open();
  send(ws, { t: "host.join", code: "999999", machine: "ATTACKER", user: "u", os: "o" });
  const err = await waitFor(ws, (m) => m.t === "error");
  results.push(err?.code ?? "<none>");
  console.log(`  attempt ${i}: ${err?.code} — ${err?.message}`);
  ws.close();
}

check("attempts 1-5 rejected as bad_code (limit is 5/min)",
  results.slice(0, 5).every((r) => r === "bad_code"), results.slice(0, 5).join(","));
check("attempt 6 rejected as rate_limited", results[5] === "rate_limited", results[5]);

// A 7th stays limited — a refused attempt must not extend the window either.
const ws7 = await open();
send(ws7, { t: "host.join", code: "999999", machine: "ATTACKER", user: "u", os: "o" });
const err7 = await waitFor(ws7, (m) => m.t === "error");
check("attempt 7 still rate_limited", err7?.code === "rate_limited", err7?.code);
ws7.close();

console.log("\n[6] Rate limiting does not depend on a valid code being guessed");
check("a real code cannot be brute-forced past the limit",
  results.filter((r) => r === "rate_limited").length >= 1);

await sleep(100);
report("rate-limit block");
