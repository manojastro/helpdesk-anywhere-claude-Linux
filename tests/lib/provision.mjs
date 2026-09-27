/**
 * After every server start: sign in the suite's bootstrap Admin (admin portal)
 * and an active Agent (technician console). Prints two lines — the admin cookie,
 * then the agent cookie — for tests/lib/server.sh to export.
 */
import { IDS, devLogin, ensureActiveUser } from "./auth.mjs";

const admin = await devLogin("admin", { objectId: IDS.admin, name: "Suite Admin", roles: ["Admin"] });
if (admin.status !== 200) {
  console.error(`admin sign-in failed: ${admin.status} ${JSON.stringify(admin.body)}`);
  process.exit(1);
}
const agentCookie = await ensureActiveUser(admin.cookie, {
  objectId: IDS.agent, name: "Suite Technician", roles: ["Agent"], agentCode: "SUITE-01",
});
// The suite's blocks open many sessions back to back; the per-user concurrency
// limit (default 3) is exercised on its own in api/30, not by accident here.
const { client } = await import("./auth.mjs");
const users = await client("admin", admin.cookie).get("/users?status=active");
const tech = users.data?.items?.find((u) => u.objectId === IDS.agent);
if (tech && tech.limits.maxConcurrentSessions !== 20) {
  await client("admin", admin.cookie).patch(`/users/${tech.id}`, { limits: { maxConcurrentSessions: 20 } });
}
console.log(admin.cookie);
console.log(agentCookie);
