/**
 * Hold / Resume at the relay (Feature Batch 1, `shared/protocol.md` "agent.hold").
 *
 * The console disables its own controls when a session is held, but that is a UI
 * courtesy: a console with a bug, an old tab, or a hand-written socket would
 * still be able to drive the customer's machine. So the boundary that decides
 * whether anything reaches that machine is here, and this block drives the wire
 * directly to prove it — no browser involved.
 *
 * It also pins down what Hold must NOT do: end the session, close a socket,
 * disturb consent, or stop the customer's screen reaching the agent.
 */
import { readFileSync, readdirSync } from "node:fs";
import { open, send, waitFor, check, sleep, report, AUDIT_DIR } from "../lib/harness.mjs";

const auditLines = () => readdirSync(AUDIT_DIR).filter((f) => f.endsWith(".jsonl"))
  .flatMap((f) => readFileSync(`${AUDIT_DIR}/${f}`, "utf8").trim().split("\n"))
  .filter(Boolean).map((l) => JSON.parse(l));

console.log("\n=== Hold / Resume — enforced by the relay, not by the console ===\n");

/* --- a consented, active session --------------------------------------------- */
const agent = await open("agent");
send(agent, { t: "agent.create" });
const code = (await waitFor(agent, (m) => m.t === "session.created"))?.code;

const host = await open("host");
send(host, { t: "host.join", code, machine: "WIN-HOLD", user: "alice", os: "Windows 11" });
await waitFor(host, (m) => m.t === "host.connectRequest");
send(host, { t: "host.consent", accepted: true });
await waitFor(agent, (m) => m.t === "consent.result");
await waitFor(host, (m) => m.t === "peer.joined" && m.role === "agent");

// Baseline: input reaches the host while the session is running normally.
host.received.length = 0;
send(agent, { t: "agent.input", kind: "mouse", x: 10, y: 20, action: "down", button: 0 });
check("baseline: input reaches the host before any hold",
  !!(await waitFor(host, (m) => m.t === "agent.input")));

/* --- 1. hold ------------------------------------------------------------------ */
console.log("\n[8] hold");
host.received.length = 0;
agent.received.length = 0;
send(agent, { t: "agent.hold", held: true });

const forwarded = await waitFor(host, (m) => m.t === "agent.hold");
check("agent.hold is forwarded to the host, so the applet can tell the user",
  forwarded?.held === true, JSON.stringify(forwarded));
check("holding does not error at the agent",
  !agent.received.some((m) => m.t === "error"), JSON.stringify(agent.received));
check("holding does not end the session",
  !agent.received.some((m) => m.t === "peer.left") && agent.closed === null);

await sleep(150);
const heldRecords = auditLines().filter((l) => l.event === "session.held" && l.code === code);
check("the hold is audited (constraint #5)", heldRecords.length === 1, `${heldRecords.length} records`);

/* --- 2. what a held session refuses ------------------------------------------- */
console.log("\n[8] a held session accepts nothing that changes the machine");

host.received.length = 0;
agent.received.length = 0;
send(agent, { t: "agent.input", kind: "mouse", x: 99, y: 99, action: "down", button: 0 });
send(agent, { t: "agent.input", kind: "key", code: "KeyA", action: "down" });
send(agent, { t: "agent.input", kind: "sas", action: "press" });
await sleep(250);
check("no input of any kind reaches the host",
  host.received.filter((m) => m.t === "agent.input").length === 0,
  JSON.stringify(host.received));
// Silently, on purpose: an in-flight mouse-move is not worth an error the console
// would paint over a live session.
check("…and input is dropped silently, not errored back at the agent",
  !agent.received.some((m) => m.t === "error"), JSON.stringify(agent.received));
check("a Secure Attention Sequence is not audited when it never left the relay",
  auditLines().filter((l) => l.event === "input.sas" && l.code === code).length === 0);

host.received.length = 0;
agent.received.length = 0;
send(agent, { t: "agent.exec", id: "held-1", shell: "powershell", script: "Remove-Item C:\\", asSystem: true });
const execRefusal = await waitFor(agent, (m) => m.t === "error");
check("a script is refused with session_held", execRefusal?.code === "session_held", JSON.stringify(execRefusal));
check("…and never reaches the host",
  host.received.filter((m) => m.t === "agent.exec").length === 0, JSON.stringify(host.received));
await sleep(150);
const execRecord = auditLines().find((l) => l.event === "exec.requested" && l.id === "held-1");
check("…and the attempt is on the record, marked refused, with the script text",
  execRecord?.refused === "session_held" && execRecord.script === "Remove-Item C:\\",
  JSON.stringify(execRecord));

host.received.length = 0;
agent.received.length = 0;
send(agent, { t: "agent.requestElevation", mode: "interactive" });
const elevRefusal = await waitFor(agent, (m) => m.t === "error");
check("an elevation is refused with session_held", elevRefusal?.code === "session_held", JSON.stringify(elevRefusal));
check("…and never reaches the host",
  host.received.filter((m) => m.t === "agent.requestElevation").length === 0);
await sleep(150);
check("…and the attempt is audited as refused",
  auditLines().some((l) => l.event === "elevation.requested" && l.code === code
    && l.refused === "session_held"));

/* --- 3. what a held session still does ---------------------------------------- */
console.log("\n[8] a held session is paused, not ended");
agent.received.length = 0;
host.send(Buffer.from([0x01, 0xff, 0xd8, 0x11]), { binary: true });
check("the customer's screen still reaches the agent while held",
  !!(await waitFor(agent, (m) => m.t === "<binary>")));

host.received.length = 0;
send(host, { t: "host.desktopChanged", desktop: "Winlogon" });
check("host → agent control messages still flow while held",
  !!(await waitFor(agent, (m) => m.t === "host.desktopChanged")));
send(host, { t: "host.desktopChanged", desktop: "Default" });

// A repeated Hold must not spam the audit log or the applet.
host.received.length = 0;
send(agent, { t: "agent.hold", held: true });
await sleep(200);
check("holding an already-held session is a no-op (no duplicate audit record)",
  auditLines().filter((l) => l.event === "session.held" && l.code === code).length === 1);
check("…and is not forwarded to the host again",
  host.received.filter((m) => m.t === "agent.hold").length === 0);

/* --- 4. resume ----------------------------------------------------------------- */
console.log("\n[8] resume");
host.received.length = 0;
send(agent, { t: "agent.hold", held: false });
const resumed = await waitFor(host, (m) => m.t === "agent.hold");
check("resume is forwarded to the host", resumed?.held === false, JSON.stringify(resumed));
await sleep(150);
check("the resume is audited",
  auditLines().filter((l) => l.event === "session.resumed" && l.code === code).length === 1);

host.received.length = 0;
send(agent, { t: "agent.input", kind: "mouse", x: 5, y: 6, action: "down", button: 0 });
const back = await waitFor(host, (m) => m.t === "agent.input");
check("input reaches the host again", back?.x === 5 && back.y === 6, JSON.stringify(back));

send(agent, { t: "agent.exec", id: "resumed-1", shell: "cmd", script: "whoami", asSystem: false });
check("scripts are accepted again",
  !!(await waitFor(host, (m) => m.t === "agent.exec" && m.id === "resumed-1")));

/* --- 5. End works while held ---------------------------------------------------- */
console.log("\n[8] End while held");
send(agent, { t: "agent.hold", held: true });
await sleep(150);
send(agent, { t: "agent.end" });
const left = await waitFor(host, (m) => m.t === "peer.left");
check("agent.end tears the session down even while it is held", left?.role === "agent",
  JSON.stringify(left));
await sleep(200);
check("…and the teardown is audited as an ended session",
  auditLines().some((l) => l.event === "session.ended" && l.code === code));

/* --- 6. hold is not reachable outside an active session -------------------------- */
console.log("\n[8] hold outside an active session");
const lone = await open("agent2");
send(lone, { t: "agent.create" });
await waitFor(lone, (m) => m.t === "session.created");
send(lone, { t: "agent.hold", held: true });
const notActive = await waitFor(lone, (m) => m.t === "error");
check("holding a session nobody has joined is refused as not_active",
  notActive?.code === "not_active", JSON.stringify(notActive));
lone.close();

report("hold/resume");
