/**
 * WebSocket signaling and stream relay (PLAN 1.3).
 *
 * Pure pass-through: relays control JSON and binary frames between the two paired
 * sockets. The server never decodes video and never inspects credentials beyond
 * the TLS check and the audit redaction.
 *
 * Phase 0 scaffold: the endpoint is mounted and rejects everything. The role
 * handshake, state-machine enforcement (drop any frame before `active`),
 * paired teardown and the 20s heartbeat land in Phase 1.3.
 */

import type { Server } from "node:http";

import { WebSocketServer } from "ws";

export function attachSignaling(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    // Phase 1.3: read the role-declaring first message (`agent.create` /
    // `host.join`), pair the sockets, enforce the state machine, relay, and
    // heartbeat every 20s. Until then, refuse cleanly rather than hang.
    ws.send(
      JSON.stringify({
        t: "error",
        code: "protocol",
        message: "signaling not implemented until Phase 1.3",
      }),
    );
    ws.close(1011, "not implemented");
  });

  return wss;
}
