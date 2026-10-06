/**
 * Configuration. Secrets and deployment settings come from environment variables
 * only — never a committed file (CLAUDE.md conventions).
 */

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`env ${name} must be an integer, got ${v}`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

function list(name: string): string[] {
  return str(name, "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function authMode(): "entra" | "dev" {
  const v = str("AUTH_MODE", "entra");
  if (v !== "entra" && v !== "dev") throw new Error(`env AUTH_MODE must be "entra" or "dev", got ${v}`);
  return v;
}

const publicHost = str("PUBLIC_HOST", "localhost:8080");
const adminPublicHost = str("ADMIN_PUBLIC_HOST", "localhost:8081");

export const config = {
  /** Internal listen port. Caddy reverse-proxies 443 to this. */
  port: int("PORT", 8080),

  /** Public hostname the portal builds join links from: https://<host>/j/<code>. */
  publicHost,

  /**
   * The admin portal is a separate application on its own listener and its own
   * hostname (admin.<domain> in production; localhost:8081 locally). It shares
   * this process, the database and the live-session state, but not a port, an
   * origin, a cookie or a sign-in with the agent console.
   */
  adminPort: int("ADMIN_PORT", 8081),
  adminPublicHost,

  /** `production` in the Docker image. Development-only auth is fatal under it. */
  nodeEnv: str("NODE_ENV", "development"),

  /** Directory for the append-only JSONL audit log (PLAN 1.6). */
  auditDir: str("AUDIT_DIR", "./audit"),

  /** Unused session codes expire after this long (PLAN 1.2). */
  sessionCodeTtlMs: int("SESSION_CODE_TTL_MS", 10 * 60 * 1000),

  /** host.join attempts allowed per IP per minute (PLAN 1.2). */
  joinAttemptsPerMinute: int("JOIN_ATTEMPTS_PER_MINUTE", 5),

  /**
   * `agent.create` calls allowed per IP per minute.
   *
   * A support agent creates a session per call, so a handful a minute is
   * generous. The cap exists because every create writes an audit record and
   * holds a code: without it, anyone who can reach an unauthenticated console
   * can grow the session map and the audit file without bound (security review,
   * 2026-09-03).
   */
  createAttemptsPerMinute: int("CREATE_ATTEMPTS_PER_MINUTE", 10),

  /**
   * Hard ceiling on live sessions. Reaching it refuses new ones rather than
   * letting the 1e6 code space and the audit log absorb an unbounded flood.
   */
  maxLiveSessions: int("MAX_LIVE_SESSIONS", 500),

  /**
   * Multi-session: the most live sessions one technician may hold at once,
   * whatever their account limit says. The effective limit is
   * min(users.max_concurrent_sessions, this). Every live session counts — a
   * code still waiting for a customer, a session awaiting consent, an active
   * one, and one whose technician socket dropped and is inside the reconnect
   * grace below — because each of them still holds a customer's machine or a
   * live pairing code.
   */
  maxConcurrentSessionsPerAgent: int("MAX_CONCURRENT_SESSIONS_PER_AGENT", 4),

  /**
   * How long a session survives its TECHNICIAN socket dropping (network blip,
   * page reload) before it is ended as `agent_disconnected`. The slot stays
   * taken throughout. The customer's side is unaffected, and only the same
   * signed-in technician presenting that session's own resume token can pick it
   * back up. 0 restores the old behaviour: a dropped socket ends the session.
   */
  agentReconnectGraceMs: int("AGENT_RECONNECT_GRACE_MS", 60_000),

  /**
   * Platform 2.0 Phase 3: how long a consented session survives the CUSTOMER's
   * connection dropping, for an applet that can resume (capability "resume").
   * The customer's indicator stays up throughout; nothing reaches their machine
   * while they are away. 0 disables (a drop ends the session, as before).
   */
  hostReconnectGraceMs: int("HOST_RECONNECT_GRACE_MS", 60_000),

  /**
   * Most simultaneous anonymous (no technician sign-in) relay sockets one IP may
   * hold (audit 2026-10-05, F-08). Anonymous sockets are customer applets; an
   * office NAT rarely has more than a handful in flight, while an unbounded
   * number lets one client exhaust file descriptors and memory.
   */
  maxAnonymousSocketsPerIp: int("MAX_ANON_SOCKETS_PER_IP", 20),

  /** `agent.resume` attempts allowed per technician per minute. */
  resumeAttemptsPerMinute: int("RESUME_ATTEMPTS_PER_MINUTE", 30),

  /**
   * Extra browser origins allowed to open the `/ws` socket, comma-separated.
   *
   * The request's own Host is always allowed, and a client that sends **no**
   * Origin at all — every non-browser client, the applet included — is always
   * allowed, because Origin is a browser-imposed header and not a credential.
   * What this stops is a *different* site scripting the relay in an agent's
   * browser (cross-site WebSocket hijacking). Normally left empty.
   */
  allowedOrigins: str("ALLOWED_ORIGINS", ""),

  /**
   * Trust `X-Forwarded-For` / `X-Forwarded-Proto` on inbound WebSocket upgrades.
   * Set only when something like Caddy actually terminates TLS in front of this
   * process (PLAN 7.3): with no proxy in front, a client can set those headers
   * itself and both defeat the join rate limiter and fake a secure transport.
   */
  trustProxy: bool("TRUST_PROXY", false),

  /**
   * Platform 2.0 file transfer: the largest single file the relay will pass in
   * either direction (it never stores any of it), and how many transfers one
   * session may run at once.
   */
  maxFileTransferBytes: int("MAX_FILE_TRANSFER_BYTES", 1024 * 1024 * 1024),
  maxTransfersPerSession: int("MAX_TRANSFERS_PER_SESSION", 3),

  /* ------------------------------------------------ Platform 2.0 feature flags */
  // Rollback switches for the riskier 2.0 features (brief §52). Off = the relay
  // refuses the feature and the console hides it; nothing else changes.
  enableFileManager: bool("ENABLE_FILE_MANAGER", true),
  enableSessionTransfer: bool("ENABLE_SESSION_TRANSFER", true),
  enableCustomerReconnect: bool("ENABLE_CUSTOMER_RECONNECT", true),
  enableScriptLibrary: bool("ENABLE_SCRIPT_LIBRARY", true),

  /** Platform 2.0 observability: JSON access-log lines for API/auth requests on stdout. */
  accessLog: bool("ACCESS_LOG", true),
  /** Bearer token for GET /metrics on the admin listener. Unset = /metrics is off (404). */
  metricsToken: str("METRICS_TOKEN", ""),

  /** Phase 5: how long the receiving technician has to answer, then the customer. */
  transferOfferTtlMs: int("TRANSFER_OFFER_TTL_MS", 60_000),
  transferCustomerTtlMs: int("TRANSFER_CUSTOMER_TTL_MS", 120_000),

  /** Credential-mode elevation attempts allowed per session (PLAN 5.2c rule 6). */
  elevationAttemptsPerSession: int("ELEVATION_ATTEMPTS_PER_SESSION", 5),

  /**
   * Local plain-HTTP development only. Credential-mode elevation is hard-refused
   * unless the connection is wss: (PLAN 5.2c rule 1). Never set in a deployment.
   */
  allowInsecureDev: bool("ALLOW_INSECURE_DEV", false),

  /* ------------------------------------------------------------ database */

  /**
   * PostgreSQL connection string. Required: sessions, chat, notes, agents and
   * reports are durable records, and the server refuses to start without them.
   */
  databaseUrl: str("DATABASE_URL", ""),

  /** Apply pending migrations at startup (under an advisory lock). */
  dbMigrateOnStart: bool("DB_MIGRATE_ON_START", true),

  /* ------------------------------------------------------------ identity */

  /**
   * `entra` (the only mode allowed in production) or `dev`, which replaces the
   * Microsoft redirect with a local sign-in form for development and tests.
   * `dev` is fatal at startup under NODE_ENV=production or on a public host.
   */
  authMode: authMode(),

  /** The one Entra tenant (directory) ID accepted by this release. */
  entraTenantId: str("ENTRA_TENANT_ID", ""),
  entraClientId: str("ENTRA_CLIENT_ID", ""),
  /** Confidential-client secret. Never logged. */
  entraClientSecret: str("ENTRA_CLIENT_SECRET", ""),
  /**
   * Web redirect URIs registered on the Entra app — one per portal. Default to
   * https://<host>/auth/callback for each portal's own hostname.
   */
  oidcRedirectUriAgent: str("OIDC_REDIRECT_URI_AGENT", ""),
  oidcRedirectUriAdmin: str("OIDC_REDIRECT_URI_ADMIN", ""),

  /** Tenant id the dev sign-in form pretends to be (AUTH_MODE=dev only). */
  devTenantId: str("DEV_TENANT_ID", "00000000-0000-4000-8000-00000000d001"),

  /** Display name for the organisation row created for the configured tenant. */
  orgName: str("ORG_NAME", "Helpdesk Anywhere"),

  /**
   * Entra object IDs allowed to become the first administrator. Takes effect only
   * for an identity that ALSO holds the Admin app role, is still pending, and
   * only while the organisation has no active administrator.
   */
  bootstrapAdminOids: list("BOOTSTRAP_ADMIN_OIDS"),

  /** Sign-in attempts (both portals, dev form included) allowed per IP per minute. */
  signInAttemptsPerMinute: int("SIGNIN_ATTEMPTS_PER_MINUTE", 20),

  /** Browser-session idle timeout and absolute lifetime. */
  authIdleMinutes: int("AUTH_IDLE_MINUTES", 120),
  authMaxHours: int("AUTH_MAX_HOURS", 12),

  /** "Agents online" = distinct active users with a console heartbeat this recent. */
  presenceWindowSeconds: int("PRESENCE_WINDOW_SECONDS", 90),

  /* ----------------------------------------------------------- retention */

  /** Chat transcripts and notes are deleted this many days after a session ends. 0 = keep forever. */
  transcriptRetentionDays: int("TRANSCRIPT_RETENTION_DAYS", 365),
  /** Session records and timelines are deleted after this many days. 0 = keep forever. */
  sessionRetentionDays: int("SESSION_RETENTION_DAYS", 730),
  /** Generated report files are downloadable for this long, then erased. */
  reportTtlMinutes: int("REPORT_TTL_MINUTES", 15),
  /** Timezone used for "today" and per-day trends on the dashboard. */
  reportTimezone: str("REPORT_TIMEZONE", "UTC"),
  /** Administrative audit rows are kept this long. 0 = keep forever. */
  auditRetentionDays: int("AUDIT_RETENTION_DAYS", 0),
} as const;

export type Config = typeof config;

/**
 * True when PUBLIC_HOST is a loopback address and no proxy is trusted — i.e. a
 * developer's own machine. Development-only switches are fatal otherwise.
 */
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function hostIsLocal(): boolean {
  return !config.trustProxy && LOOPBACK.test(config.publicHost) && LOOPBACK.test(config.adminPublicHost);
}

export type Portal = "agent" | "admin";

export function portalHost(portal: Portal): string {
  return portal === "admin" ? config.adminPublicHost : config.publicHost;
}

/** Plain HTTP is only ever used for AUTH_MODE=dev on a loopback host. */
export function portalScheme(): "http" | "https" {
  return config.authMode === "dev" && hostIsLocal() ? "http" : "https";
}

export function redirectUri(portal: Portal): string {
  const override = portal === "admin" ? config.oidcRedirectUriAdmin : config.oidcRedirectUriAgent;
  return override !== "" ? override : `${portalScheme()}://${portalHost(portal)}/auth/callback`;
}
