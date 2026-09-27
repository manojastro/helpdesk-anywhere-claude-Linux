/**
 * Drive a real support session over the real relay: a signed-in technician
 * socket and an anonymous applet-shaped host socket, exactly as in production.
 */
import { open, send, waitFor, sleep } from "./harness.mjs";

/** Technician creates a session; returns { agent, created } or { agent, error }. */
export async function create(cookie, label = "agent") {
  const agent = await open(label, { headers: { cookie } });
  send(agent, { t: "agent.create" });
  const first = await waitFor(agent, (m) => m.t === "session.created" || m.t === "error", 4000);
  return first?.t === "session.created" ? { agent, created: first } : { agent, error: first };
}

/** Create, join, consent: an active session. */
export async function active(cookie, { machine = "WIN-TEST", user = "customer", os = "Windows 11", label = "s" } = {}) {
  const { agent, created, error } = await create(cookie, `agent-${label}`);
  if (!created) throw new Error(`agent.create failed: ${JSON.stringify(error)}`);
  const host = await open(`host-${label}`);
  send(host, { t: "host.join", code: created.code, machine, user, os });
  const connectRequest = await waitFor(host, (m) => m.t === "host.connectRequest");
  send(host, { t: "host.consent", accepted: true });
  await waitFor(agent, (m) => m.t === "consent.result");
  await waitFor(host, (m) => m.t === "peer.joined" && m.role === "agent");
  return { agent, host, created, sessionId: created.sessionId, code: created.code, connectRequest };
}

/** Wait for the per-session write queue to drain (writes are asynchronous by design). */
export const settle = (ms = 400) => sleep(ms);
