/**
 * Roles, permissions and record scoping — the one place that decides who may do
 * what. Every HTTP route and every privileged WebSocket message asks this
 * module; hiding a button in the UI is never the control.
 *
 * Effective access = an eligible Entra app role (from the verified ID token)
 * AND an active application user record. The application can only narrow what
 * the Entra role allows (the per-user limits), never widen it.
 */

/** App roles defined on the Entra app registration (docs/ENTRA_SETUP.md). */
export const APP_ROLES = ["Admin", "Supervisor", "Agent", "Auditor"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export function isAppRole(v: unknown): v is AppRole {
  return typeof v === "string" && (APP_ROLES as readonly string[]).includes(v);
}

/** Keep only role values this application defines. */
export function eligibleRoles(claim: unknown): AppRole[] {
  if (!Array.isArray(claim)) return [];
  return [...new Set(claim.filter(isAppRole))].sort((a, b) => APP_ROLES.indexOf(a) - APP_ROLES.indexOf(b));
}

export interface UserLimits {
  canUseConsole: boolean;
  allowScripts: boolean;
  /** Platform 2.0: browse, upload, download and change files on the customer's machine. */
  allowFileTransfer: boolean;
  allowElevation: boolean;
  canExport: boolean;
  maxConcurrentSessions: number;
}

export type UserStatus = "pending" | "active" | "suspended";

/** The authenticated, authorised caller, rebuilt from the database on every request. */
export interface Principal {
  userId: string;
  orgId: string;
  tenantId: string;
  objectId: string;
  displayName: string;
  email: string | null;
  agentCode: string | null;
  teamId: string | null;
  status: UserStatus;
  /** Roles from the ID token of THIS browser session (not a later admin edit). */
  roles: AppRole[];
  limits: UserLimits;
  authMethod: "entra" | "dev";
  csrfToken: string;
  /** Hex SHA-256 of the session cookie; identifies the browser session. */
  sessionHash: string;
  sessionExpiresAt: Date;
  /** The application this browser session belongs to. */
  portal: "agent" | "admin";
}

export type Permission =
  | "console.use"
  | "dashboard.view"
  | "sessions.read"
  | "sessions.terminate"
  | "transcripts.read"
  | "notes.read"
  | "reports.export"
  | "users.read"
  | "users.manage"
  | "teams.manage"
  | "audit.read"
  // Platform 2.0: the saved script library. Reading it in the admin portal is
  // oversight; changing what technicians can run with one click is admin-only.
  | "scripts.read"
  | "scripts.manage";

const ROLE_PERMISSIONS: Record<AppRole, readonly Permission[]> = {
  Admin: [
    "console.use", "dashboard.view", "sessions.read", "sessions.terminate", "transcripts.read",
    "notes.read", "reports.export", "users.read", "users.manage", "teams.manage", "audit.read",
    "scripts.read", "scripts.manage",
  ],
  Supervisor: [
    "console.use", "dashboard.view", "sessions.read", "sessions.terminate", "transcripts.read",
    "notes.read", "reports.export", "users.read", "scripts.read",
  ],
  Agent: ["console.use", "sessions.read", "transcripts.read", "notes.read", "reports.export"],
  // Read-only oversight: no console, no access changes, no terminating.
  Auditor: ["dashboard.view", "sessions.read", "transcripts.read", "notes.read", "reports.export", "audit.read", "users.read", "scripts.read"],
};

export function can(p: Principal, perm: Permission): boolean {
  if (p.status !== "active") return false;
  if (!p.roles.some((r) => ROLE_PERMISSIONS[r].includes(perm))) return false;
  // Application-level limits narrow the role.
  if (perm === "console.use" && !p.limits.canUseConsole) return false;
  if (perm === "reports.export" && !p.limits.canExport) return false;
  return true;
}

export function permissionsOf(p: Principal): Permission[] {
  const all = new Set<Permission>();
  for (const r of p.roles) for (const perm of ROLE_PERMISSIONS[r]) all.add(perm);
  return [...all].filter((perm) => can(p, perm));
}

/**
 * How much session data a principal can see:
 *   all  — Admin, Auditor: every session in the organisation;
 *   team — Supervisor: sessions of their team, plus their own;
 *   own  — Agent: only sessions they ran.
 */
export type Scope = "all" | "team" | "own";

export function sessionScope(p: Principal): Scope {
  if (p.roles.includes("Admin") || p.roles.includes("Auditor")) return "all";
  if (p.roles.includes("Supervisor")) return "team";
  return "own";
}

/**
 * SQL fragment restricting `alias`.sessions rows to what `p` may see. Always
 * includes the organisation; parameters are appended to `params`.
 */
export function sessionScopeSql(p: Principal, params: unknown[], alias = "s"): string {
  params.push(p.orgId);
  const org = `${alias}.org_id = $${params.length}`;
  const scope = sessionScope(p);
  if (scope === "all") return org;

  params.push(p.userId);
  const own = `${alias}.agent_user_id = $${params.length}`;
  if (scope === "team" && p.teamId !== null) {
    params.push(p.teamId);
    return `${org} AND (${own} OR ${alias}.team_id = $${params.length})`;
  }
  return `${org} AND ${own}`;
}

/** In-memory twin of `sessionScopeSql`, for live sessions that are not rows yet. */
export function canSeeSession(p: Principal, s: { orgId: string; agentUserId: string; teamId: string | null }): boolean {
  if (s.orgId !== p.orgId) return false;
  const scope = sessionScope(p);
  if (scope === "all") return true;
  if (s.agentUserId === p.userId) return true;
  return scope === "team" && p.teamId !== null && s.teamId === p.teamId;
}

/**
 * Who may sign in to which application at all. The agent console is for people
 * who run sessions; the admin portal is for oversight roles only — an Agent-only
 * identity is refused there no matter what URL it knows.
 */
export function mayUsePortal(roles: readonly AppRole[], portal: "agent" | "admin"): boolean {
  if (portal === "agent") return roles.some((r) => r === "Admin" || r === "Supervisor" || r === "Agent");
  return roles.some((r) => r === "Admin" || r === "Supervisor" || r === "Auditor");
}

/** Primary role for display: the most privileged one held. */
export function primaryRole(roles: readonly AppRole[]): AppRole | null {
  return roles[0] ?? null;
}
