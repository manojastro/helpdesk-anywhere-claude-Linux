/**
 * Development sign-in helpers for the suite (AUTH_MODE=dev only — the server
 * refuses that mode in production, which block api/34 asserts).
 *
 * Identities are (objectId, roles). Each portal issues its own cookie.
 */

const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.HDA_TEST_PORT ?? "8099"}`;
const ADMIN_BASE = process.env.ADMIN_BASE ?? `http://127.0.0.1:${process.env.HDA_TEST_ADMIN_PORT ?? "8098"}`;

export { BASE, ADMIN_BASE };

export const IDS = {
  admin: process.env.HDA_TEST_BOOTSTRAP_OID ?? "aaaaaaaa-0000-4000-8000-00000000ad01",
  agent: "bbbbbbbb-0000-4000-8000-00000000a901",
};

/** POST /auth/dev/login on a portal. Returns { status, body, cookie }. */
export async function devLogin(portal, { objectId, name = "Test User", email = null, roles = [], tenantId } = {}) {
  const base = portal === "admin" ? ADMIN_BASE : BASE;
  const res = await fetch(`${base}/auth/dev/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ objectId, name, email, roles, ...(tenantId ? { tenantId } : {}) }),
  });
  const body = await res.json().catch(() => ({}));
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, body, cookie };
}

/** A small API client bound to one portal and one cookie, handling CSRF. */
export function client(portal, cookie) {
  const base = portal === "admin" ? ADMIN_BASE : BASE;
  const prefix = portal === "admin" ? "/api/admin" : "/api/agent";
  let csrf = null;
  async function call(method, path, body, { raw = false, headers = {}, noCsrf = false } = {}) {
    if (method !== "GET" && csrf === null && !noCsrf) {
      const me = await fetch(`${base}${prefix}/me`, { headers: { cookie } });
      csrf = me.ok ? (await me.json()).csrfToken : "";
    }
    const res = await fetch(`${base}${path.startsWith("/") && !path.startsWith("/api") && !path.startsWith("/auth") ? prefix + path : path}`, {
      method,
      redirect: "manual",
      headers: {
        cookie,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(method !== "GET" && !noCsrf ? { "X-CSRF-Token": csrf ?? "" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw) return res;
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }
  return {
    get: (p, o) => call("GET", p, undefined, o),
    post: (p, b = {}, o) => call("POST", p, b, o),
    patch: (p, b = {}, o) => call("PATCH", p, b, o),
    raw: (m, p, b, o) => call(m, p, b, { ...o, raw: true }),
  };
}

/**
 * Sign in `objectId` on the admin portal as a (bootstrapped) admin; activate any
 * pending technician identity with `agentCode`; return the technician's console
 * cookie. Idempotent.
 */
export async function ensureActiveUser(adminCookie, { objectId, name, roles, agentCode, teamId = null }, portal = "agent") {
  let r = await devLogin(portal, { objectId, name, roles });
  if (r.status === 200) return r.cookie;
  if (r.body.error !== "pending" || !r.body.userId) throw new Error(`cannot sign in ${name}: ${JSON.stringify(r.body)}`);
  const admin = client("admin", adminCookie);
  const act = await admin.post(`/users/${r.body.userId}/activate`, { agentCode, teamId });
  if (act.status !== 200) throw new Error(`activation of ${name} failed: ${JSON.stringify(act.data)}`);
  r = await devLogin(portal, { objectId, name, roles });
  if (r.status !== 200) throw new Error(`sign-in after activation failed: ${JSON.stringify(r.body)}`);
  return r.cookie;
}
