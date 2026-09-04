/**
 * WebSocket signaling and stream relay (PLAN 1.3).
 *
 * Pure pass-through: relays control JSON and binary frames between the two
 * paired sockets. The server never decodes video and never inspects a credential
 * beyond the transport check and the audit redaction.
 *
 * Two rules carry the security weight here:
 *   - Nothing is relayed before `state === "active"`, so no frame can reach the
 *     agent before the user has consented (CLAUDE.md constraint #1).
 *   - Credential-mode elevation is refused outright on a non-secure transport
 *     and is forwarded verbatim, never re-serialised, buffered or logged
 *     (CLAUDE.md constraint #6, `shared/protocol.md` "Credential handling").
 */

import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import { audit } from "./audit.js";
import { consoleAuthEnabled, hasConsoleCookie } from "./auth.js";
import { config } from "./config.js";
import {
  isCredentialElevation,
  type AnyMessage,
  type ErrorCode,
  type HostInfo,
  type Role,
  type ServerMessage,
} from "./protocol.js";
import { SessionCapacityError, sessions, type Session } from "./sessions.js";

/** PLAN 1.3: ping every 20s, drop peers that never pong back. */
const HEARTBEAT_MS = 20_000;

/** PLAN 1.2: sweep expired and ended sessions on a 60s timer. */
const SWEEP_MS = 60_000;

/** Refuse absurd control frames outright; video goes over binary frames. */
const MAX_CONTROL_BYTES = 256 * 1024;

interface Conn {
  ws: WebSocket;
  ip: string;
  /** Whether the original client connection was TLS-protected. */
  secure: boolean;
  /**
   * Whether this socket came from a browser that passed the console's Basic auth.
   * Browsers send cookies with the WebSocket upgrade, so the console's socket is
   * recognisable here — while the applet's, which has no cookie and must never
   * need one, is not. Only `agent.create` is gated on it.
   */
  consoleAuthed: boolean;

  /** Null until the socket declares itself with `agent.create` / `host.join`. */
  role: Role | null;
  code: string | null;
  alive: boolean;
}

const conns = new Map<WebSocket, Conn>();

/* ----------------------------------------------------------------- connection info */

/**
 * The client IP the join rate limiter is keyed on.
 *
 * Behind a reverse proxy the socket address is the proxy, so the real client is
 * the *last* `X-Forwarded-For` entry — the one the trusted proxy appended.
 * Earlier entries are attacker-controlled. Without `TRUST_PROXY` the header is
 * ignored entirely.
 */
function clientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const header = req.headers["x-forwarded-for"];
    const raw = Array.isArray(header) ? header.join(",") : header;
    const parts = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const nearest = parts[parts.length - 1];
    if (nearest !== undefined) return nearest;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * Whether the *client's* connection is TLS-protected. Caddy terminates TLS and
 * speaks plain ws to this process, so behind a trusted proxy the header is the
 * only evidence; `ALLOW_INSECURE_DEV` overrides it for local development only.
 */
function isSecure(req: IncomingMessage): boolean {
  const socket: Socket & { encrypted?: boolean } = req.socket;
  if (socket.encrypted === true) return true;

  if (config.trustProxy) {
    const header = req.headers["x-forwarded-proto"];
    const raw = Array.isArray(header) ? header[0] : header;
    const proto = raw?.split(",")[0]?.trim().toLowerCase();
    if (proto === "https" || proto === "wss") return true;
  }
  return false;
}

/** Wire size of a control frame. `RawData` is a Buffer, an ArrayBuffer or a list of Buffers. */
function controlByteLength(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.length;
  if (Array.isArray(data)) return data.reduce((n, part) => n + part.length, 0);
  return (data as ArrayBuffer).byteLength;
}

/* ------------------------------------------------------------------- origin policy */

/**
 * Reject a browser socket opened from a *different* site (cross-site WebSocket
 * hijacking).
 *
 * The applet is not a browser and sends no `Origin` at all, so a missing Origin
 * must stay allowed — Origin is a header browsers impose on their own pages, not
 * a credential, and demanding one would only break every non-browser client.
 * What it does buy: with console authentication on, the console's cookie is what
 * makes `agent.create` work, and this stops another site from borrowing it in
 * the agent's browser. SameSite=lax already blocks that in current browsers;
 * this does not depend on the browser getting it right.
 */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || origin === "") return true;  // not a browser

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;  // a browser always sends a well-formed origin
  }

  if (host !== undefined && originHost === host) return true;
  if (originHost === config.publicHost) return true;

  return config.allowedOrigins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .some((allowed) => {
      try {
        return new URL(allowed).host === originHost;
      } catch {
        return allowed === originHost;  // a bare host:port is accepted too
      }
    });
}

/* --------------------------------------------------------------------- send helpers */

function send(ws: WebSocket | null, msg: ServerMessage): void {
  if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendError(ws: WebSocket | null, code: ErrorCode, message: string): void {
  send(ws, { t: "error", code, message });
}

/** Forward a frame verbatim — never re-serialised, so nothing is buffered or logged. */
function forward(ws: WebSocket | null, data: RawData, isBinary: boolean): void {
  if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(data, { binary: isBinary });
}

/* -------------------------------------------------------------------------- teardown */

/**
 * End a session once: notify the surviving peer, close both sockets, audit.
 * Idempotent — the store returns undefined for a session already torn down, so
 * the close handlers that fire as a result cannot recurse.
 */
function teardown(code: string, reason: string, departed: Role | null): void {
  const session = sessions.end(code);
  if (!session) return;

  const peers: Array<[WebSocket | null, Role]> = [
    [session.agentWs, "agent"],
    [session.hostWs, "host"],
  ];

  for (const [ws, role] of peers) {
    if (ws === null) continue;
    const conn = conns.get(ws);
    if (conn) conn.code = null;

    if (departed !== null && role !== departed) send(ws, { t: "peer.left", role: departed });
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, "session ended");
  }

  void audit("session.ended", code, {
    reason,
    machine: session.hostInfo?.machine ?? null,
    durationMs: session.consentedAt === null ? null : Date.now() - session.consentedAt,
  });
}

/* ------------------------------------------------------------------- role handshake */

function handleAgentCreate(conn: Conn): void {
  // A create costs a code and an audit record, so it is rate-limited exactly as
  // a join is. Without a console password anyone at all can reach this
  // (security review, 2026-09-03).
  if (!sessions.createLimiter.allow(conn.ip)) {
    sendError(conn.ws, "rate_limited", "Too many sessions created. Wait a minute and try again.");
    void audit("join.rejected", null, { ip: conn.ip, reason: "create_rate_limited" });
    return;
  }

  let session: Session;
  try {
    session = sessions.create(conn.ws);
  } catch (err) {
    if (!(err instanceof SessionCapacityError)) throw err;
    sendError(conn.ws, "rate_limited", "The server is at capacity. Try again shortly.");
    void audit("join.rejected", null, { ip: conn.ip, reason: "at_capacity" });
    return;
  }

  conn.role = "agent";
  conn.code = session.code;

  send(conn.ws, { t: "session.created", code: session.code });
  void audit("session.created", session.code, { ip: conn.ip });
}

function handleHostJoin(conn: Conn, msg: AnyMessage): void {
  if (msg.t !== "host.join") return;

  const code = typeof msg.code === "string" ? msg.code : "";
  const info: HostInfo = {
    machine: String(msg.machine ?? ""),
    user: String(msg.user ?? ""),
    os: String(msg.os ?? ""),
  };

  // Rate limit BEFORE looking the code up, so a guesser cannot use response
  // timing to tell a real code from a fake one (PLAN 1.2).
  if (!sessions.joinLimiter.allow(conn.ip)) {
    sendError(conn.ws, "rate_limited", "Too many attempts. Wait a minute and try again.");
    void audit("join.rejected", code, { ip: conn.ip, reason: "rate_limited" });
    return;
  }

  const result = sessions.claim(code, conn.ws, info);

  if (!result.ok) {
    const message =
      result.error === "code_expired"
        ? "That code has expired. Ask your agent for a new one."
        : "That code is not valid. Check the digits and try again.";

    sendError(conn.ws, result.error, message);
    void audit("join.rejected", code, { ip: conn.ip, reason: result.error, ...info });
    // Socket stays open: the applet shows the error and lets the user retype
    // (PLAN 2.2). The per-IP limiter, not the socket, is what caps guessing.
    return;
  }

  const { session } = result;
  conn.role = "host";
  conn.code = session.code;

  void audit("session.joined", session.code, { ip: conn.ip, ...info });

  // Drives the consent dialog. Nothing streams until the user accepts.
  send(conn.ws, { t: "host.connectRequest", agentName: config.agentName });
  send(session.agentWs, { t: "peer.joined", role: "host", info });
}

/* --------------------------------------------------------------------- agent → host */

function handleAgentMessage(
  conn: Conn,
  session: Session,
  msg: AnyMessage,
  data: RawData,
): void {
  if (msg.t === "agent.end") {
    teardown(session.code, "agent ended session", "agent");
    return;
  }

  if (session.state !== "active") {
    sendError(conn.ws, "not_active", "The session is not active yet.");
    return;
  }

  if (msg.t === "agent.requestElevation") {
    relayElevation(conn, session, msg, data);
    return;
  }

  if (msg.t === "agent.input" && msg.kind === "sas") {
    // Ordinary mouse and key events are far too many to audit, but the Secure
    // Attention Sequence is not one of them: it is only reachable once the
    // session has been elevated, and it is the agent reaching the Windows
    // security screen. Constraint #5 wants privileged actions on the record.
    void audit("input.sas", session.code, {});
  }

  if (msg.t === "agent.exec") {
    // PLAN 1.6: the full script text is audited BEFORE the process can start.
    void audit("exec.requested", session.code, {
      id: msg.id,
      shell: msg.shell,
      asSystem: msg.asSystem,
      script: msg.script,
    });
  }

  forward(session.hostWs, data, false);
}

/**
 * Elevation requests (PLAN 5.2c). The transport check and the rate limit live
 * here because the message crosses this relay from Phase 1 onward — leaving the
 * guard until Phase 5 would mean a window where a password relays unchecked.
 *
 * The password is never read, never re-serialised and never logged: the audit
 * record carries only the mode, username and outcome, and the frame is forwarded
 * exactly as received.
 */
function relayElevation(
  conn: Conn,
  session: Session,
  msg: AnyMessage,
  data: RawData,
): void {
  if (msg.t !== "agent.requestElevation") return;

  const credential = isCredentialElevation(msg);
  const detail = credential
    ? { mode: "credential", domain: msg.domain, username: msg.username }
    : { mode: "interactive" };

  if (credential && !conn.secure && !config.allowInsecureDev) {
    sendError(
      conn.ws,
      "insecure_transport",
      "Admin credentials cannot be sent over an unencrypted connection.",
    );
    void audit("elevation.requested", session.code, {
      ...detail,
      refused: "insecure_transport",
    });
    return;
  }

  session.elevationAttempts += 1;
  if (session.elevationAttempts > config.elevationAttemptsPerSession) {
    sendError(
      conn.ws,
      "elevation_rate_limited",
      "Too many elevation attempts in this session.",
    );
    void audit("elevation.requested", session.code, {
      ...detail,
      refused: "elevation_rate_limited",
      attempt: session.elevationAttempts,
    });
    return;
  }

  void audit("elevation.requested", session.code, {
    ...detail,
    attempt: session.elevationAttempts,
  });

  forward(session.hostWs, data, false);
}

/* --------------------------------------------------------------------- host → agent */

function handleHostMessage(
  conn: Conn,
  session: Session,
  msg: AnyMessage,
  data: RawData,
  isBinary: boolean,
): void {
  if (msg.t === "host.consent") {
    handleConsent(conn, session, msg.accepted === true);
    return;
  }

  if (session.state !== "active") {
    sendError(conn.ws, "not_active", "The session is not active yet.");
    return;
  }

  if (msg.t === "host.elevated") {
    void audit("elevation.result", session.code, { ok: msg.ok, error: msg.error ?? null });
  } else if (msg.t === "host.execResult" && msg.partial !== true) {
    // Only the final result is audited; the partial chunks that stream before it
    // would otherwise write one audit record per 250ms of script output.
    void audit("exec.result", session.code, { id: msg.id, exitCode: msg.exitCode });
  }

  forward(session.agentWs, data, isBinary);
}

function handleConsent(conn: Conn, session: Session, accepted: boolean): void {
  if (session.state !== "waiting_for_consent") {
    sendError(conn.ws, "protocol", "Consent was not expected at this point.");
    return;
  }

  void audit("session.consent", session.code, {
    accepted,
    machine: session.hostInfo?.machine ?? null,
    user: session.hostInfo?.user ?? null,
  });

  send(session.agentWs, { t: "consent.result", accepted });

  if (!accepted) {
    teardown(session.code, "user declined consent", "host");
    return;
  }

  session.state = "active";
  session.consentedAt = Date.now();
  send(session.hostWs, { t: "peer.joined", role: "agent" });
}

/* ------------------------------------------------------------------ message dispatch */

function onMessage(conn: Conn, data: RawData, isBinary: boolean): void {
  const session = conn.code === null ? undefined : sessions.get(conn.code);

  if (isBinary) {
    // Only the host sends binary, and only once the user has consented.
    if (conn.role !== "host" || !session || session.state !== "active") {
      sendError(conn.ws, "not_active", "The session is not active yet.");
      return;
    }
    forward(session.agentWs, data, true);
    return;
  }

  // Byte length, not string length: a cap counted in UTF-16 units lets a
  // multi-byte payload be three times the intended size.
  if (controlByteLength(data) > MAX_CONTROL_BYTES) {
    sendError(conn.ws, "protocol", "Control message too large.");
    conn.ws.close(1009, "control message too large");
    return;
  }

  const text = data.toString();
  let msg: AnyMessage;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    if (typeof (parsed as { t?: unknown }).t !== "string") throw new Error("no discriminator");
    msg = parsed as AnyMessage;
  } catch {
    sendError(conn.ws, "protocol", "Malformed message.");
    conn.ws.close(1002, "malformed message");
    return;
  }

  // The first message declares the role; anything else closes the socket.
  if (conn.role === null) {
    if (msg.t === "agent.create") {
      // Protecting only the console *page* would be half a lock: the socket is
      // what actually creates sessions, and a session code is what a
      // tech-support scammer needs (CLAUDE.md 7.5).
      if (consoleAuthEnabled && !conn.consoleAuthed) {
        sendError(conn.ws, "protocol", "The agent console requires authentication.");
        void audit("join.rejected", "", { ip: conn.ip, reason: "console_unauthenticated" });
        conn.ws.close(1008, "console authentication required");
        return;
      }
      handleAgentCreate(conn);
    }
    else if (msg.t === "host.join") handleHostJoin(conn, msg);
    else {
      sendError(conn.ws, "protocol", "First message must be agent.create or host.join.");
      conn.ws.close(1002, "role not declared");
    }
    return;
  }

  if (!session) {
    sendError(conn.ws, "protocol", "This session has ended.");
    conn.ws.close(1000, "session ended");
    return;
  }

  if (conn.role === "agent") {
    if (!msg.t.startsWith("agent.") || msg.t === "agent.create") {
      sendError(conn.ws, "protocol", `Unexpected ${msg.t} from an agent socket.`);
      return;
    }
    handleAgentMessage(conn, session, msg, data);
    return;
  }

  if (!msg.t.startsWith("host.") || msg.t === "host.join") {
    sendError(conn.ws, "protocol", `Unexpected ${msg.t} from a host socket.`);
    return;
  }
  handleHostMessage(conn, session, msg, data, isBinary);
}

/* ------------------------------------------------------------------------- lifecycle */

export function attachSignaling(server: Server): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: 8 * 1024 * 1024,
    verifyClient: ({ origin, req }, done) => {
      if (originAllowed(origin, req.headers.host)) {
        done(true);
        return;
      }
      console.warn(`[ws] refused an upgrade from origin ${origin}`);
      done(false, 403, "Forbidden origin");
    },
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const conn: Conn = {
      ws,
      ip: clientIp(req),
      secure: isSecure(req),
      consoleAuthed: hasConsoleCookie(req),
      role: null,
      code: null,
      alive: true,
    };
    conns.set(ws, conn);

    ws.on("pong", () => {
      conn.alive = true;
    });

    ws.on("message", (data: RawData, isBinary: boolean) => {
      try {
        onMessage(conn, data, isBinary);
      } catch (err) {
        // Never let one bad frame take the process down mid-session. The message
        // itself is not logged: it may be a credential-mode elevation.
        console.error("[ws] handler error:", err instanceof Error ? err.message : err);
        sendError(ws, "protocol", "Message could not be handled.");
      }
    });

    ws.on("close", () => {
      conns.delete(ws);
      // PLAN 1.3: close both sides when either drops.
      if (conn.code !== null) teardown(conn.code, `${conn.role ?? "peer"} disconnected`, conn.role);
    });

    ws.on("error", (err) => {
      console.error("[ws] socket error:", err.message);
    });
  });

  const heartbeat = setInterval(() => {
    for (const conn of conns.values()) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }, HEARTBEAT_MS);

  const sweeper = setInterval(() => {
    for (const session of sessions.sweep()) {
      sendError(session.agentWs, "code_expired", "The session code expired unused.");
      if (session.agentWs?.readyState === WebSocket.OPEN) {
        session.agentWs.close(1000, "code expired");
      }
      void audit("session.ended", session.code, { reason: "code expired unused" });
    }
  }, SWEEP_MS);

  heartbeat.unref();
  sweeper.unref();

  wss.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(sweeper);
  });

  return wss;
}
