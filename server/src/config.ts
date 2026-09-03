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

export const config = {
  /** Internal listen port. Caddy reverse-proxies 443 to this. */
  port: int("PORT", 8080),

  /** Public hostname the portal builds join links from: https://<host>/j/<code>. */
  publicHost: str("PUBLIC_HOST", "localhost:8080"),

  /** Directory for the append-only JSONL audit log (PLAN 1.6). */
  auditDir: str("AUDIT_DIR", "./audit"),

  /**
   * Display name the host's consent dialog names as the requester
   * (CLAUDE.md constraint #1 — the modal must name the requesting agent).
   * The console has no authentication in this POC (PLAN "out of scope"), so
   * there is no signed-in identity to derive this from.
   */
  agentName: str("AGENT_NAME", "Support Agent"),

  /** Unused session codes expire after this long (PLAN 1.2). */
  sessionCodeTtlMs: int("SESSION_CODE_TTL_MS", 10 * 60 * 1000),

  /** host.join attempts allowed per IP per minute (PLAN 1.2). */
  joinAttemptsPerMinute: int("JOIN_ATTEMPTS_PER_MINUTE", 5),

  /**
   * Trust `X-Forwarded-For` / `X-Forwarded-Proto` on inbound WebSocket upgrades.
   * Set only when something like Caddy actually terminates TLS in front of this
   * process (PLAN 7.3): with no proxy in front, a client can set those headers
   * itself and both defeat the join rate limiter and fake a secure transport.
   */
  trustProxy: bool("TRUST_PROXY", false),

  /** Credential-mode elevation attempts allowed per session (PLAN 5.2c rule 6). */
  elevationAttemptsPerSession: int("ELEVATION_ATTEMPTS_PER_SESSION", 5),

  /**
   * Username for the agent console's HTTP Basic authentication (PLAN 7.3).
   * Only meaningful when `consolePassword` is set.
   */
  consoleUser: str("CONSOLE_USER", "agent"),

  /**
   * Shared password protecting the agent console. **Empty disables the check**,
   * which is right for local development and wrong for anything reachable from
   * the internet — the server warns loudly at startup when that combination
   * occurs. Never logged, and never sent anywhere by the server.
   *
   * This is not user authentication (`PLAN.md` puts that out of scope); it keeps
   * a public console from being usable by whoever finds the URL. See
   * `server/src/auth.ts`.
   */
  consolePassword: str("CONSOLE_PASSWORD", ""),

  /**
   * Local plain-HTTP development only. Credential-mode elevation is hard-refused
   * unless the connection is wss: (PLAN 5.2c rule 1). Never set in a deployment.
   */
  allowInsecureDev: bool("ALLOW_INSECURE_DEV", false),
} as const;

export type Config = typeof config;
