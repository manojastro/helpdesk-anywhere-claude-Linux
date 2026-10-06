/**
 * Configuration that must stop the server before it listens. Pure, so the test
 * suite can assert every rule without starting a process — and index.ts exits
 * non-zero with these messages when any applies.
 */

import { config, hostIsLocal } from "./config.js";

export function startupProblems(c: typeof config = config, local: boolean = hostIsLocal()): string[] {
  const problems: string[] = [];

  if (c.databaseUrl === "") {
    problems.push("DATABASE_URL is not set. Sessions, chat, notes and access control are durable records; the server will not run without PostgreSQL.");
  }

  // Development sign-in is an authentication bypass by design. It exists for a
  // developer's loopback machine and the test suite, and nowhere else.
  if (c.authMode === "dev") {
    if (c.nodeEnv === "production") {
      problems.push("AUTH_MODE=dev is refused under NODE_ENV=production. Production sign-in is Microsoft Entra ID only (AUTH_MODE=entra).");
    }
    if (!local) {
      problems.push(
        `AUTH_MODE=dev is refused on a non-loopback deployment (PUBLIC_HOST=${c.publicHost}, ` +
        `ADMIN_PUBLIC_HOST=${c.adminPublicHost}, TRUST_PROXY=${c.trustProxy ? "1" : "0"}).`,
      );
    }
  } else if (c.entraTenantId === "" || c.entraClientId === "" || c.entraClientSecret === "") {
    problems.push("AUTH_MODE=entra needs ENTRA_TENANT_ID, ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET (docs/ENTRA_SETUP.md).");
  }

  // ALLOW_INSECURE_DEV switches off the one check that keeps an administrator
  // password off a plaintext wire (PLAN 5.2c rule 1). A stale line in a .env
  // travels to a public host unnoticed, so this is fatal rather than loud.
  if (c.allowInsecureDev && !local) {
    problems.push(
      "ALLOW_INSECURE_DEV is set on what looks like a real deployment. That flag permits administrator " +
      "credentials over an unencrypted connection (CLAUDE.md constraint #6.1).",
    );
  }

  // The database CHECK allows account limits of 1–20; a ceiling outside that
  // range is a typo, and 0 would silently lock every technician out.
  if (!Number.isInteger(c.maxConcurrentSessionsPerAgent) || c.maxConcurrentSessionsPerAgent < 1 || c.maxConcurrentSessionsPerAgent > 20) {
    problems.push(`MAX_CONCURRENT_SESSIONS_PER_AGENT must be between 1 and 20 (got ${c.maxConcurrentSessionsPerAgent}).`);
  }
  if (c.hostReconnectGraceMs < 0 || c.hostReconnectGraceMs > 10 * 60_000) {
    problems.push(`HOST_RECONNECT_GRACE_MS must be between 0 and 600000 (got ${c.hostReconnectGraceMs}).`);
  }
  if (c.agentReconnectGraceMs < 0 || c.agentReconnectGraceMs > 10 * 60_000) {
    problems.push(`AGENT_RECONNECT_GRACE_MS must be between 0 and 600000 (got ${c.agentReconnectGraceMs}).`);
  }

  if (c.port === c.adminPort) {
    problems.push("PORT and ADMIN_PORT must differ: the agent console and the admin portal are separate applications.");
  }
  if (c.publicHost === c.adminPublicHost) {
    problems.push("PUBLIC_HOST and ADMIN_PUBLIC_HOST must differ (app.<domain> and admin.<domain>; localhost:8080 and localhost:8081 locally).");
  }
  return problems;
}
