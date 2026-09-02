#!/usr/bin/env node
/**
 * Mock Windows applet (PLAN 1.1 acceptance).
 *
 * A tiny `ws` client that speaks the host half of `shared/protocol.md`, so the
 * server can be exercised end-to-end on Ubuntu before any C# exists. It is a
 * test tool, not a product component — the real applet is Phase 2.
 *
 * Usage:
 *   node scripts/mock-host.js <code> [options]
 *
 *   --url <ws://host/ws>   server endpoint      (default ws://localhost:8080/ws)
 *   --decline              answer the consent prompt with false
 *   --no-consent           connect and join, but never answer
 *   --machine/--user/--os  values reported in host.join
 *   --json                 emit one JSON line per received message
 *   --stay                 keep running after consent (default: exit on close)
 *
 * Exit codes: 0 clean, 1 refused by the server, 2 usage/transport error.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `ws` is a dependency of the server package, and this script lives outside it
// (PLAN puts it at scripts/mock-host.js). Resolve from the server package so the
// script runs from any cwd without a second node_modules tree.
const require = createRequire(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../server/package.json"),
);
const { WebSocket } = require("ws");

/** Options that consume the following argument; everything else is a flag. */
const VALUED = new Set(["url", "machine", "user", "os"]);

const options = new Map();
const flags = new Set();
const positional = [];

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) {
    positional.push(arg);
    continue;
  }
  const name = arg.slice(2);
  if (VALUED.has(name)) options.set(name, process.argv[++i]);
  else flags.add(name);
}

const option = (name, fallback) => options.get(name) ?? fallback;

const code = positional[0];
if (code === undefined) {
  console.error("usage: node scripts/mock-host.js <code> [--url ws://…] [--decline]");
  process.exit(2);
}

const url = option("url", "ws://localhost:8080/ws");
const asJson = flags.has("json");
const accepted = !flags.has("decline");
const answerConsent = !flags.has("no-consent");
const stay = flags.has("stay");

const hostInfo = {
  machine: option("machine", "MOCK-PC"),
  user: option("user", "testuser"),
  os: option("os", "Windows 11 Pro 22H2 (mock)"),
};

let exitCode = 0;

function log(direction, payload) {
  if (asJson) console.log(JSON.stringify({ direction, ...payload }));
  else console.log(`${direction} ${JSON.stringify(payload)}`);
}

const ws = new WebSocket(url);

ws.on("open", () => {
  const join = { t: "host.join", code, ...hostInfo };
  log("→", join);
  ws.send(JSON.stringify(join));
});

ws.on("message", (data, isBinary) => {
  if (isBinary) {
    log("←", { t: "<binary>", bytes: data.length });
    return;
  }

  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    log("←", { t: "<unparseable>", raw: data.toString().slice(0, 200) });
    return;
  }
  log("←", msg);

  switch (msg.t) {
    case "host.connectRequest": {
      // CLAUDE.md constraint #1: the real applet shows a modal naming
      // msg.agentName here and streams nothing before the user accepts.
      if (!answerConsent) return;
      const consent = { t: "host.consent", accepted };
      log("→", consent);
      ws.send(JSON.stringify(consent));
      if (!accepted) setTimeout(() => ws.close(), 100);
      break;
    }

    case "peer.joined":
      if (msg.role === "agent" && !stay) {
        // Paired and active. A real applet would start capturing here (Phase 3).
      }
      break;

    case "error":
      exitCode = 1;
      break;

    default:
      break;
  }
});

ws.on("close", (codeNum, reason) => {
  log("×", { closed: codeNum, reason: reason.toString() });
  process.exit(exitCode);
});

ws.on("error", (err) => {
  console.error(`transport error: ${err.message}`);
  process.exit(2);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (ws.readyState === WebSocket.OPEN) ws.close();
    else process.exit(exitCode);
  });
}
