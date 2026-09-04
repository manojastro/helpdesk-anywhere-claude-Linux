/**
 * Wire protocol — TypeScript mirror of `shared/protocol.md`.
 *
 * `shared/protocol.md` is the single source of truth; this file and
 * `windows/Shared/Protocol.cs` mirror it. CHANGE ALL THREE TOGETHER
 * (CLAUDE.md conventions).
 */

export type Role = "agent" | "host";

export type DesktopName = "Default" | "Winlogon" | "Screen-saver";

export type SessionState =
  | "waiting_for_host"
  | "waiting_for_consent"
  | "active"
  | "ended";

export type ErrorCode =
  | "bad_code"
  | "code_expired"
  | "rate_limited"
  | "not_active"
  | "insecure_transport"
  | "elevation_rate_limited"
  | "protocol";

/* ------------------------------------------------------------------ agent → server */

export interface AgentCreate {
  t: "agent.create";
}

export interface AgentMouseInput {
  t: "agent.input";
  kind: "mouse";
  /** Remote pixels in virtual-desktop space, not CSS pixels. */
  x: number;
  y: number;
  action: "move" | "down" | "up" | "wheel";
  /** 0 = left, 1 = middle, 2 = right. Null for move/wheel. */
  button: 0 | 1 | 2 | null;
  wheelDelta?: number;
}

export interface AgentKeyInput {
  t: "agent.input";
  kind: "key";
  /** DOM `event.code` (physical key), not `event.key`. */
  code: string;
  action: "down" | "up";
}

/**
 * Ctrl+Alt+Del (PLAN 4.3). Not a key chord: `SendInput` cannot produce a Secure
 * Attention Sequence, so the applet routes this to the elevated service's
 * `SendSAS()`. The console only enables it after `host.elevated { ok:true }`.
 */
export interface AgentSasInput {
  t: "agent.input";
  kind: "sas";
  /** Always "press"; present only because every agent.input carries an action. */
  action: "press";
}

export type AgentInput = AgentMouseInput | AgentKeyInput | AgentSasInput;

export interface AgentExec {
  t: "agent.exec";
  id: string;
  shell: "powershell" | "cmd";
  script: string;
  asSystem: boolean;
}

export interface AgentRequestElevationInteractive {
  t: "agent.requestElevation";
  mode: "interactive";
}

export interface AgentRequestElevationCredential {
  t: "agent.requestElevation";
  mode: "credential";
  domain: string;
  username: string;
  /**
   * NEVER logged, persisted or buffered. Refused over non-wss:. Redacted by
   * `audit.ts` before anything reaches disk. See `shared/protocol.md`
   * "Credential handling" and PLAN 5.2c.
   */
  password: string;
}

export type AgentRequestElevation =
  | AgentRequestElevationInteractive
  | AgentRequestElevationCredential;

export interface AgentEnd {
  t: "agent.end";
}

export type AgentMessage =
  | AgentCreate
  | AgentInput
  | AgentExec
  | AgentRequestElevation
  | AgentEnd;

/* ------------------------------------------------------------------- host → server */

export interface HostJoin {
  t: "host.join";
  code: string;
  machine: string;
  user: string;
  os: string;
}

export interface HostConsent {
  t: "host.consent";
  accepted: boolean;
}

export interface HostDesktopChanged {
  t: "host.desktopChanged";
  desktop: DesktopName;
}

export interface HostElevated {
  t: "host.elevated";
  ok: boolean;
  /** A mapped, human-readable message — never a raw credential. */
  error?: string;
}

export interface HostExecResult {
  t: "host.execResult";
  id: string;
  /** Meaningless (-1) while `partial` is true. */
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * True for an incremental chunk streamed while the script is still running.
   * Only the final, non-partial result is audited. See `shared/protocol.md`
   * "host.execResult streaming".
   */
  partial?: boolean;
}

export type HostMessage =
  | HostJoin
  | HostConsent
  | HostDesktopChanged
  | HostElevated
  | HostExecResult;

/* ------------------------------------------------------------------ server → peers */

export interface SessionCreated {
  t: "session.created";
  code: string;
}

export interface HostConnectRequest {
  t: "host.connectRequest";
  agentName: string;
}

export interface ConsentResult {
  t: "consent.result";
  accepted: boolean;
}

export interface HostInfo {
  machine: string;
  user: string;
  os: string;
}

export interface PeerJoined {
  t: "peer.joined";
  role: Role;
  info?: HostInfo;
}

export interface PeerLeft {
  t: "peer.left";
  role: Role;
}

export interface ProtocolError {
  t: "error";
  code: ErrorCode;
  message: string;
}

export type ServerMessage =
  | SessionCreated
  | HostConnectRequest
  | ConsentResult
  | PeerJoined
  | PeerLeft
  | ProtocolError;

export type AnyMessage = AgentMessage | HostMessage | ServerMessage;

/* ------------------------------------------------------------------- binary frames */

/** `[0x01][jpeg bytes]` — full frame. */
export const FRAME_FULL = 0x01;

/** `[0x02][x:u16][y:u16][w:u16][h:u16][jpeg bytes]` — dirty rect (Phase 3.3). */
export const FRAME_DIRTY_RECT = 0x02;

/** Byte length of the `[0x02]` header, big-endian, tag byte included. */
export const DIRTY_RECT_HEADER_BYTES = 9;

/* ------------------------------------------------------------------------ narrowing */

export function isAgentMessage(m: AnyMessage): m is AgentMessage {
  return m.t.startsWith("agent.");
}

export function isHostMessage(m: AnyMessage): m is HostMessage {
  return m.t.startsWith("host.") && m.t !== "host.connectRequest";
}

export function isCredentialElevation(
  m: AnyMessage,
): m is AgentRequestElevationCredential {
  return m.t === "agent.requestElevation" && m.mode === "credential";
}
