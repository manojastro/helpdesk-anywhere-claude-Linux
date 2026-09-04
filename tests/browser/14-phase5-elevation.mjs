/**
 * Phase 5 acceptance (Linux half): the console's elevation panel, the desktop
 * banner, and the Ctrl+Alt+Del button.
 *
 * Every Win32 part of Phase 5 — CreateProcessWithLogonW, the service, the
 * Winlogon desktop — needs Windows and is MT-06 in MANUAL_TESTS.md. What can be
 * verified here is the half that decides whether the agent can drive it at all,
 * plus the credential-handling rules from PLAN 5.2c that live in the browser: the
 * password is sent once, cleared immediately, and never written to storage.
 *
 * This block runs with ALLOW_INSECURE_DEV=1 for one reason: over plain `ws://`
 * the relay HARD-REFUSES a credential-mode elevation and never forwards it
 * (CLAUDE.md constraint #6.1), so the frame the console builds could not be
 * inspected at the host at all. That refusal is asserted where it belongs, on a
 * server without the flag — `ws/05-phase1-audit.mjs`, which also proves the
 * password reaches neither the audit log nor the server's own output.
 */
import { launch, openConsole, startSession } from "../lib/browser.mjs";
import { WebSocket, BASE, URL_WS, sleep } from "../lib/harness.mjs";

const WS = URL_WS;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const browser = await launch();

console.log("\n=== Phase 5 — elevation panel, desktop banner, SAS ===\n");

const page = await openConsole(browser, BASE, { viewport: { width: 1400, height: 1200 } });
const errors = page.errors;
const code = await startSession(page);

const host = new WebSocket(WS);
const received = [];
host.on("message", (d, b) => { if (!b) received.push(JSON.parse(d.toString())); });
await new Promise((res) => host.once("open", res));
host.send(JSON.stringify({ t: "host.join", code, machine: "WIN-TEST", user: "alice", os: "Windows" }));
await sleep(250);

const SENTINEL = "Tr0ub4dor-Sentinel-Passw0rd!";

/* --- 1. nothing is elevatable before consent -------------------------------- */
check("the elevation panel is disabled before consent",
  await page.$eval("#elevation", (f) => f.disabled) === true);
check("Ctrl+Alt+Del is disabled before elevation (PLAN 4.3)",
  await page.$eval("#send-sas", (b) => b.disabled) === true);

host.send(JSON.stringify({ t: "host.consent", accepted: true }));
await page.waitForFunction(() => document.getElementById("status").textContent.trim() === "Connected");
check("consent enables the elevation panel",
  await page.$eval("#elevation", (f) => f.disabled) === false);

/* --- 2. interactive mode (PLAN 5.2a) ---------------------------------------- */
received.length = 0;
await page.click("#elevate");
await sleep(250);
const interactive = received.find((m) => m.t === "agent.requestElevation");
check("the default mode sends mode:interactive with no credential fields",
  interactive?.mode === "interactive" && !("password" in (interactive ?? {})),
  JSON.stringify(interactive));

// PLAN 5.2a is explicit that the console must say the prompt is on the USER's
// screen — otherwise the agent waits, sees nothing, and assumes it is broken.
const waitingText = await page.$eval("#elev-status", (e) => e.textContent);
check("…and the console says the prompt is on the user's screen",
  /approve/i.test(waitingText) && /their screen|user/i.test(waitingText), JSON.stringify(waitingText));

host.send(JSON.stringify({ t: "host.elevated", ok: false, error: "The user declined the Windows prompt." }));
await sleep(250);
check("a declined elevation shows the applet's mapped message, not a code",
  (await page.$eval("#elev-status", (e) => e.textContent)).includes("declined"));
check("…and leaves the session running, unelevated",
  (await page.$eval("#status", (e) => e.textContent.trim())) === "Connected");
check("…and leaves Ctrl+Alt+Del disabled",
  await page.$eval("#send-sas", (b) => b.disabled) === true);

/* --- 3. credential mode (PLAN 5.2b / 5.2c) ---------------------------------- */
await page.click('input[name="elev-mode"][value="credential"]');
await sleep(100);
check("choosing credential mode reveals the credential fields",
  await page.$eval("#cred-fields", (d) => !d.hidden));

received.length = 0;
await page.click("#elevate");
await sleep(200);
check("an empty username is refused before anything is sent",
  received.filter((m) => m.t === "agent.requestElevation").length === 0 &&
  /username/i.test(await page.$eval("#elev-status", (e) => e.textContent)));

await page.type("#elev-domain", "CORP");
await page.type("#elev-username", "svc-admin");
await page.type("#elev-password", SENTINEL);
received.length = 0;
await page.click("#elevate");
await sleep(300);

const credential = received.find((m) => m.t === "agent.requestElevation");
check("credential mode sends domain, username and password",
  credential?.mode === "credential" && credential.domain === "CORP" &&
  credential.username === "svc-admin" && credential.password === SENTINEL,
  credential ? `${credential.domain}\\${credential.username}` : "no frame");

/* PLAN 5.2c rule 4, console side. */
check("the password field is cleared the instant it is sent",
  await page.$eval("#elev-password", (i) => i.value) === "",
  JSON.stringify(await page.$eval("#elev-password", (i) => i.value)));

const stored = await page.evaluate((secret) => {
  const scan = (store) => {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if ((store.getItem(k) ?? "").includes(secret) || k.includes(secret)) return true;
    }
    return false;
  };
  return { local: scan(localStorage), session: scan(sessionStorage) };
}, SENTINEL);
check("the password is in neither localStorage nor sessionStorage",
  !stored.local && !stored.session, JSON.stringify(stored));

const inDom = await page.evaluate((secret) => document.body.innerHTML.includes(secret), SENTINEL);
check("…and is not left anywhere in the page markup", !inDom);

/* --- 4. success unlocks the secure-desktop affordances ---------------------- */
host.send(JSON.stringify({ t: "host.elevated", ok: true }));
await sleep(300);
check("a successful elevation says so", /elevated/i.test(await page.$eval("#elev-status", (e) => e.textContent)));
check("…enables Ctrl+Alt+Del (PLAN 4.3: needs SendSAS from the service)",
  await page.$eval("#send-sas", (b) => b.disabled) === false);
check("…and closes the panel, since elevation is once per session",
  await page.$eval("#elevation", (f) => f.disabled) === true);

received.length = 0;
await page.click("#send-sas");
await sleep(250);
const sas = received.find((m) => m.t === "agent.input");
check("the Ctrl+Alt+Del button sends kind:sas, NOT a three-key chord",
  sas?.kind === "sas" && sas.action === "press" &&
  !received.some((m) => m.t === "agent.input" && m.kind === "key"),
  JSON.stringify(sas));

/* --- 5. the desktop banner (PLAN 5.6) --------------------------------------- */
host.send(JSON.stringify({ t: "host.desktopChanged", desktop: "Winlogon" }));
await sleep(250);
check("host.desktopChanged Winlogon raises the UAC banner",
  await page.$eval("#uac-banner", (b) => !b.hidden));

host.send(JSON.stringify({ t: "host.desktopChanged", desktop: "Default" }));
await sleep(250);
check("…and returning to the user's desktop lowers it",
  await page.$eval("#uac-banner", (b) => b.hidden));

/* --- 6. session end resets everything --------------------------------------- */
await page.click("#end-session");
await sleep(400);
const afterEnd = await page.evaluate(() => ({
  panel: document.getElementById("elevation").disabled,
  sas: document.getElementById("send-sas").disabled,
  status: document.getElementById("elev-status").textContent,
  username: document.getElementById("elev-username").value,
  password: document.getElementById("elev-password").value,
  banner: document.getElementById("uac-banner").hidden,
}));
check("session end disables the panel and Ctrl+Alt+Del again",
  afterEnd.panel === true && afterEnd.sas === true, JSON.stringify(afterEnd));
check("…and clears the credential fields and the status",
  afterEnd.username === "" && afterEnd.password === "" && afterEnd.status === "",
  JSON.stringify(afterEnd));
check("…and lowers the banner", afterEnd.banner === true);
check("no uncaught page errors", errors.length === 0, errors.join(" | "));

try { host.close(); } catch {}
await browser.close();
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
