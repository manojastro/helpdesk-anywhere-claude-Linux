/**
 * Configurations that must never run — above all, the development sign-in form
 * (an authentication bypass by design) anywhere near production.
 */
import { spawn, spawnSync } from "node:child_process";

import { REPO, check, report, sleep } from "../lib/harness.mjs";
import { DATABASE_URL } from "../lib/db.mjs";

const ENTRY = `${REPO}/server/dist/index.js`;
const BASE_ENV = {
  PATH: process.env.PATH, AUDIT_DIR: "/tmp/hda-startup-probe", PORT: "8121", ADMIN_PORT: "8122",
  PUBLIC_HOST: "localhost:8121", ADMIN_PUBLIC_HOST: "localhost:8122", DATABASE_URL,
};

function run(env) {
  const r = spawnSync(process.execPath, [ENTRY], { env: { ...BASE_ENV, ...env }, encoding: "utf8", timeout: 15_000 });
  return { status: r.status, err: r.stderr ?? "" };
}

console.log("\n=== Startup refusals ===\n");

const prodDev = run({ AUTH_MODE: "dev", NODE_ENV: "production" });
check("AUTH_MODE=dev under NODE_ENV=production refuses to start", prodDev.status === 1 && /AUTH_MODE=dev is refused under NODE_ENV=production/.test(prodDev.err), prodDev.err.split("\n")[0]);

const publicDev = run({ AUTH_MODE: "dev", PUBLIC_HOST: "app.example.org", ADMIN_PUBLIC_HOST: "admin.example.org" });
check("AUTH_MODE=dev on a public hostname refuses to start", publicDev.status === 1 && /non-loopback/.test(publicDev.err));

const proxiedDev = run({ AUTH_MODE: "dev", TRUST_PROXY: "1" });
check("AUTH_MODE=dev behind a trusted proxy refuses to start", proxiedDev.status === 1 && /non-loopback/.test(proxiedDev.err));

const adminPublicDev = run({ AUTH_MODE: "dev", ADMIN_PUBLIC_HOST: "admin.example.org" });
check("…including when only the admin portal's hostname is public", adminPublicDev.status === 1 && /non-loopback/.test(adminPublicDev.err));

const noEntra = run({ AUTH_MODE: "entra" });
check("AUTH_MODE=entra without tenant/client/secret refuses to start", noEntra.status === 1 && /ENTRA_TENANT_ID/.test(noEntra.err));

const defaultMode = run({});
check("the default mode is entra (dev must be asked for explicitly)", defaultMode.status === 1 && /AUTH_MODE=entra needs/.test(defaultMode.err));

const badMode = run({ AUTH_MODE: "none" });
check("an unknown AUTH_MODE refuses to start", badMode.status !== 0);

const noDb = run({ AUTH_MODE: "dev", DATABASE_URL: "" });
check("no DATABASE_URL refuses to start", noDb.status === 1 && /DATABASE_URL is not set/.test(noDb.err));

const samePort = run({ AUTH_MODE: "dev", ADMIN_PORT: "8121" });
check("the admin portal cannot share the console's port", samePort.status === 1 && /PORT and ADMIN_PORT must differ/.test(samePort.err));

const sameHost = run({ AUTH_MODE: "dev", ADMIN_PUBLIC_HOST: "localhost:8121" });
check("…or its hostname", sameHost.status === 1 && /must differ/.test(sameHost.err));

const deadDb = run({ AUTH_MODE: "dev", DATABASE_URL: "postgres://nobody:x@127.0.0.1:1/none" });
check("an unreachable database refuses to start (no silent record loss)", deadDb.status === 1 && /database initialisation failed/.test(deadDb.err));

console.log("\n[34] In entra mode the development sign-in route does not exist");
const child = spawn(process.execPath, [ENTRY], {
  env: { ...BASE_ENV, AUTH_MODE: "entra", ENTRA_TENANT_ID: "11111111-1111-4111-8111-111111111111",
    ENTRA_CLIENT_ID: "22222222-2222-4222-8222-222222222222", ENTRA_CLIENT_SECRET: "not-a-real-secret" },
  stdio: ["ignore", "pipe", "pipe"],
});
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await sleep(150);
  up = await fetch("http://127.0.0.1:8121/healthz").then((r) => r.ok, () => false);
}
check("the server starts in entra mode", up);
for (const port of [8121, 8122]) {
  const r = await fetch(`http://127.0.0.1:${port}/auth/dev/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ objectId: "aaaaaaaa-0000-4000-8000-00000000ad01", name: "x", roles: ["Admin"] }),
  });
  check(`POST /auth/dev/login on :${port} is not a route (${r.status})`, r.status === 401 || r.status === 404);
  check(`…and set no session cookie`, (r.headers.getSetCookie?.() ?? []).length === 0);
  const cfg = await (await fetch(`http://127.0.0.1:${port}/auth/config`)).json();
  check(`/auth/config on :${port} advertises entra only`, cfg.mode === "entra");
}
child.kill("SIGTERM");
await sleep(300);

report("startup refusals");
