/**
 * Phase 1 acceptance, protocol half (PLAN.md Phase 1 "Acceptance"):
 * happy path, pre-consent frame suppression, wrong code, single-use burn and
 * agent.end teardown. The browser half is browser/10-phase1-console.mjs.
 */
import { open, send, waitFor, check, sleep, report, WebSocket } from "../lib/harness.mjs";

console.log("\n=== Phase 1 acceptance — protocol level ===\n");

// ---------------------------------------------------------------- happy path
console.log("[1] Happy path: create → join → connectRequest → consent(true) → Connected");
const agent = await open("agent");
send(agent, { t: "agent.create" });
const created = await waitFor(agent, (m) => m.t === "session.created");
check("agent receives session.created", !!created);
const code = created?.code;
check("code is 6 numeric digits", /^\d{6}$/.test(code ?? ""), `code=${code}`);

const host = await open("host");
send(host, { t: "host.join", code, machine: "MOCK-PC", user: "testuser", os: "Windows 11 (mock)" });

const connectReq = await waitFor(host, (m) => m.t === "host.connectRequest");
check("host receives host.connectRequest", !!connectReq, `agentName=${connectReq?.agentName}`);
check("connectRequest names the requesting agent (CLAUDE.md #1)",
  typeof connectReq?.agentName === "string" && connectReq.agentName.length > 0);

const peerJoined = await waitFor(agent, (m) => m.t === "peer.joined" && m.role === "host");
check("agent receives peer.joined with host info", !!peerJoined,
  JSON.stringify(peerJoined?.info));

// Nothing may relay before consent (CLAUDE.md constraint #1).
host.send(Buffer.from([0x01, 0xff, 0xd8]), { binary: true });
const notActive = await waitFor(host, (m) => m.t === "error" && m.code === "not_active");
check("binary frame before consent is refused (not_active)", !!notActive);
const leaked = agent.received.find((m) => m.t === "<binary>");
check("no frame reached the agent before consent", !leaked);

send(host, { t: "host.consent", accepted: true });
const consentRes = await waitFor(agent, (m) => m.t === "consent.result");
check("agent receives consent.result accepted:true", consentRes?.accepted === true);
const agentPeer = await waitFor(host, (m) => m.t === "peer.joined" && m.role === "agent");
check("host receives peer.joined role:agent (state=active)", !!agentPeer);

// Relay now works both ways.
host.send(Buffer.from([0x01, 0xff, 0xd8, 0xaa]), { binary: true });
const relayed = await waitFor(agent, (m) => m.t === "<binary>");
check("binary frame relays to agent once active", !!relayed, `${relayed?.bytes} bytes`);

send(agent, { t: "agent.input", kind: "key", code: "KeyA", action: "down" });
const inputRelayed = await waitFor(host, (m) => m.t === "agent.input");
check("agent.input relays to host once active", !!inputRelayed);

// ------------------------------------------------------------- wrong code
console.log("\n[2] Wrong code is rejected");
const bad = await open("bad");
send(bad, { t: "host.join", code: "000001", machine: "X", user: "y", os: "z" });
const badErr = await waitFor(bad, (m) => m.t === "error");
check("unknown code → error bad_code", badErr?.code === "bad_code", JSON.stringify(badErr));
bad.close();

// ------------------------------------------------------- code reused twice
console.log("\n[3] A code reused twice is rejected (single-use burn)");
const second = await open("second");
send(second, { t: "host.join", code, machine: "SECOND-PC", user: "u", os: "o" });
const reuseErr = await waitFor(second, (m) => m.t === "error");
check("second join with a burned code → bad_code", reuseErr?.code === "bad_code",
  JSON.stringify(reuseErr));
const noSecondReq = second.received.find((m) => m.t === "host.connectRequest");
check("second host never receives connectRequest", !noSecondReq);
second.close();

// -------------------------------------------------------- agent.end teardown
console.log("\n[4] agent.end tears down both sides");
send(agent, { t: "agent.end" });
const hostLeft = await waitFor(host, (m) => m.t === "peer.left" && m.role === "agent");
check("host receives peer.left role:agent", !!hostLeft);
await sleep(200);
check("host socket closed by server", host.readyState === WebSocket.CLOSED || host.readyState === WebSocket.CLOSING,
  `readyState=${host.readyState}`);
check("agent socket closed by server", agent.readyState === WebSocket.CLOSED || agent.readyState === WebSocket.CLOSING,
  `readyState=${agent.readyState}`);

report("protocol block");
