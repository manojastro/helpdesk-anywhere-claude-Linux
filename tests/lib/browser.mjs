/**
 * Headless-Chrome plumbing for the browser suites.
 *
 * Neither Puppeteer nor Chrome is a dependency of the product, so neither lives
 * in the repo. `tests/setup-browser.sh` puts both in a cache directory outside
 * the tree; this module finds them there, or wherever the environment points.
 *
 * Resolution order for each:
 *   Puppeteer  $HDA_PUPPETEER_HOME → tests/node_modules → $CACHE/puppeteer
 *   Chrome     $CHROME_PATH → $CACHE/chrome → puppeteer's own bundled browser
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { REPO } from "./harness.mjs";

export const CACHE = process.env.HDA_TEST_CACHE ?? `${homedir()}/.cache/helpdesk-anywhere`;

function resolvePuppeteer() {
  const roots = [
    process.env.HDA_PUPPETEER_HOME,
    `${REPO}/tests`,
    `${CACHE}/puppeteer`,
  ].filter(Boolean);
  for (const root of roots) {
    const anchor = `${root}/package.json`;
    if (!existsSync(anchor)) continue;
    try {
      return createRequire(anchor)("puppeteer");
    } catch { /* try the next root */ }
  }
  throw new Error(
    "puppeteer not found. Run tests/setup-browser.sh, or set HDA_PUPPETEER_HOME " +
    `to a directory whose node_modules contains it. Looked in: ${roots.join(", ")}`,
  );
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    `${CACHE}/chrome/chrome-linux64/chrome`,
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));  // undefined → puppeteer's own
}

/** Launch headless Chrome with the flags this container/VM needs. */
export async function launch() {
  const puppeteer = resolvePuppeteer();
  return puppeteer.launch({
    headless: true,
    executablePath: chromePath(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

/**
 * Open the agent console, authenticating first when CONSOLE_PASSWORD is set, so
 * the same suites run against both the bare dev server and the deployed
 * container with console auth on (DECISIONS.md D-008).
 */
export async function openConsole(browser, base, { viewport } = {}) {
  const page = await browser.newPage();
  if (viewport) await page.setViewport(viewport);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // Chrome requests /favicon.ico on its own and the portal specifies no icon;
  // that 404 is not a page error, and its URL is on location(), not in text().
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const url = m.location()?.url ?? "";
    if (url.includes("favicon")) return;
    errors.push(`${m.text()} [${url}]`);
  });
  if (process.env.CONSOLE_PASSWORD) {
    await page.authenticate({
      username: process.env.CONSOLE_USER ?? "agent",
      password: process.env.CONSOLE_PASSWORD,
    });
  }
  await page.goto(base, { waitUntil: "domcontentloaded" });
  page.errors = errors;
  return page;
}

/** Create a session from the console and return its six-digit code. */
export async function startSession(page) {
  await page.click("#start-session");
  await page.waitForFunction(
    () => document.getElementById("code").textContent.trim() !== "------",
    { timeout: 5000 },
  );
  return page.$eval("#code", (e) => e.textContent.trim());
}
