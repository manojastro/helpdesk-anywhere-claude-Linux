/**
 * Shared assertions and a raw-WebSocket client for the protocol-level suites.
 *
 * `ws` is resolved from the server's own node_modules — the test suite adds no
 * dependency of its own for the non-browser blocks.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const { WebSocket } = createRequire(`${REPO}/server/package.json`)("ws");

export const PORT = process.env.HDA_TEST_PORT ?? "8099";
export const BASE = process.env.BASE ?? `http://127.0.0.1:${PORT}`;
export const URL_WS = process.env.WS_URL ?? `ws://127.0.0.1:${PORT}/ws`;
export const AUDIT_DIR = process.env.AUDIT_DIR ?? "/tmp/hda-test-audit";
export const SERVER_LOG = process.env.SERVER_LOG ?? "/tmp/hda-test-server.log";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const state = { pass: 0, fail: 0 };
export function check(name, ok, detail = "") {
  ok ? state.pass++ : state.fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** Open a socket that records everything it receives, JSON-decoded. */
export function open(label = "") {
  const ws = new WebSocket(URL_WS);
  ws.received = [];
  ws.label = label;
  ws.closed = null;
  ws.on("message", (d, bin) => {
    ws.received.push(bin ? { t: "<binary>", bytes: d.length } : JSON.parse(d.toString()));
  });
  ws.on("close", (c, r) => { ws.closed = { code: c, reason: r.toString() }; });
  return new Promise((res, rej) => {
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}

/** Wait until a recorded message matches `pred`, or time out and return null. */
export async function waitFor(ws, pred, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = ws.received.find(pred);
    if (hit) return hit;
    await sleep(20);
  }
  return null;
}

export const send = (ws, msg) => ws.send(JSON.stringify(msg));

export function report(label) {
  console.log(`\n--- ${label}: ${state.pass} passed, ${state.fail} failed ---`);
  process.exit(state.fail === 0 ? 0 : 1);
}
