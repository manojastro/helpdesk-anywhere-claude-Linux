/**
 * Platform 2.0 feature flags (brief §52): with every ENABLE_* switch off, the
 * relay refuses each feature and tells the console; everything else still works.
 * Server started with ENABLE_FILE_MANAGER=false ENABLE_SESSION_TRANSFER=false
 * ENABLE_CUSTOMER_RECONNECT=false ENABLE_SCRIPT_LIBRARY=false.
 */
import { client } from "../lib/auth.mjs";
import { check, open, report, send, waitFor } from "../lib/harness.mjs";

const cookie = process.env.HDA_AGENT_COOKIE;
const api = client("agent", cookie);
console.log("\n=== Platform 2.0 feature flags off ===\n");

const me = (await api.get("/me")).data;
check("/me tells the console every flag is off", JSON.stringify(me.features) === JSON.stringify({ fileManager: false, sessionTransfer: false, customerReconnect: false, scriptLibrary: false }), JSON.stringify(me.features));
const lib = (await api.get("/scripts")).data;
check("script library off: empty and marked disabled", lib.items.length === 0 && lib.disabled === true);
check("transfer off: nobody is available", (await api.get("/technicians/available")).data.disabled === true);

const agent = await open("agent", { headers: { cookie } });
send(agent, { t: "agent.create" });
const created = await waitFor(agent, (m) => m.t === "session.created", 4000);
const host = await open("host");
send(host, { t: "host.join", code: created.code, machine: "FLAG-PC", user: "f", os: "Windows 11", protocolVersion: 2, capabilities: ["files", "transfer", "resume", "clipboard"] });
await waitFor(host, (m) => m.t === "host.connectRequest");
send(host, { t: "host.consent", accepted: true });
await waitFor(agent, (m) => m.t === "consent.result");
await new Promise((r) => setTimeout(r, 300));
check("customer reconnect off: no resume token is issued", !host.received.some((m) => m.t === "host.resumeToken"));
send(agent, { t: "agent.fs.list", rid: "r1", path: "" });
check("file manager off: refused feature_disabled, not forwarded", (await waitFor(agent, (m) => m.t === "error" && m.rid === "r1"))?.code === "feature_disabled" && !host.received.some((m) => m.t === "agent.fs.list"));
send(agent, { t: "agent.transfer.offer", toUserId: "00000000-0000-4000-8000-000000000000" });
check("session transfer off: refused feature_disabled", (await waitFor(agent, (m) => m.t === "error" && m.code === "feature_disabled" && !m.rid))?.code === "feature_disabled");
send(agent, { t: "agent.clipboard.get", rid: "c1" });
check("…while other features (clipboard) still work", !!(await waitFor(host, (m) => m.t === "agent.clipboard.get")));
send(agent, { t: "agent.input", kind: "key", code: "KeyA", action: "down" });
check("…and remote control is untouched", !!(await waitFor(host, (m) => m.t === "agent.input")));
send(agent, { t: "agent.end" });
report("ws/17 feature flags");
