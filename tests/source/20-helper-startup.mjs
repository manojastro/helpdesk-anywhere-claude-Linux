/**
 * DesktopHelper startup and the watcher's helper lifecycle — MT-06 follow-up.
 *
 * SECOND real Windows run of Phase 5 (2026-09-05): the secure-desktop watcher now
 * runs in the interactive session and correctly detects Default -> Winlogon, but
 * the DesktopHelper it launches EXITED ~300ms after every launch and was
 * relaunched in a tight loop — on the Default desktop too, before any UAC prompt.
 * The watcher logged `exitCode=?` and no `[helper]` lines reached the applet's
 * unified log, so the failing stage could not be read from the evidence at all.
 *
 * These checks lock in the changes that make the next run diagnosable and stop the
 * damage, and the one design fix that removes a whole class of the failure. They
 * do NOT prove the helper runs on Winlogon — only a Windows machine can — so they
 * are a backstop for MT-06, not a substitute.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { check, report, REPO } from "../lib/harness.mjs";

const read = (p) => readFileSync(`${REPO}/${p}`, "utf8");
const code = (p) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\/\/\/.*$/gm, "");

const entry = code("windows/Applet/Program.cs");
const helper = code("windows/DesktopHelper/Program.cs");
const watcher = code("windows/SecureDesktopService/SessionWatcher.cs");

console.log("\n=== DesktopHelper startup & lifecycle (MT-06 follow-up) ===\n");

/* --- 1. mode dispatch: the helper never becomes the applet ------------------ */
console.log("[1] Mode dispatch");

check("--desktop-helper dispatches to DesktopHelper.Program.Run",
  /args\.Contains\("--desktop-helper"\)\s*\)\s*\{?\s*return DesktopHelper\.Program\.Run\(args\)/.test(entry));
check("--desktop-watch dispatches to SessionWatcher.Run",
  /args\.Contains\("--desktop-watch"\)[\s\S]{0,80}SessionWatcher\.Run\(args\)/.test(entry));
check("--run-service dispatches to the service",
  /args\.Contains\("--run-service"\)[\s\S]{0,80}SecureDesktopService\.Program\.Run\(args\)/.test(entry));

// The three elevated modes must be decided BEFORE WinForms is initialised: a
// helper that fell through to ApplicationConfiguration.Initialize would try to
// stand up a UI as SYSTEM on the Winlogon desktop.
const helperIdx = entry.indexOf('args.Contains("--desktop-helper")');
const watchIdx = entry.indexOf('args.Contains("--desktop-watch")');
const initIdx = entry.indexOf("ApplicationConfiguration.Initialize()");
check("every elevated mode is dispatched before ApplicationConfiguration.Initialize",
  helperIdx > 0 && watchIdx > 0 && initIdx > 0 && helperIdx < initIdx && watchIdx < initIdx);

/* --- 2. nothing kills a second instance ------------------------------------ */
console.log("\n[2] The helper may run while the applet already exists");

// git grep exits 1 when there is no match, which is exactly the outcome we want.
let anyMutex = "";
try {
  anyMutex = execFileSync("git", ["grep", "-lI", "-e", "Mutex", "-e", "CreateMutex", "--", "windows"],
    { cwd: REPO, encoding: "utf8" }).trim();
} catch (e) {
  if (e.status !== 1) throw e;   // 1 = no matches; anything else is a real failure
}
check("no single-instance mutex anywhere in windows/ (the applet, service, watcher and helper are all the same exe)",
  anyMutex === "", anyMutex);

/* --- 3. command line the watcher builds ------------------------------------ */
console.log("\n[3] Helper command line");

check("the watcher builds \"exe\" --desktop-helper --desktop <d> --pipe <p>",
  /"\\?"?\{_helperPath\}\\?"? --desktop-helper --desktop \{desktop\} --pipe \{_pipeName\}/.test(watcher) ||
  /\{_helperPath\}[\s\S]{0,40}--desktop-helper --desktop \{desktop\} --pipe \{_pipeName\}/.test(watcher));
check("the exe path is quoted, so a Program Files-style path with a space survives CreateProcess",
  /\\"\{_helperPath\}\\"/.test(read("windows/SecureDesktopService/SessionWatcher.cs")));
check("lpDesktop carries the window-station prefix",
  /lpDesktop = \$@"WinSta0\\\{desktop\}"/.test(watcher));

/* --- 4. earliest-possible helper logging ----------------------------------- */
console.log("\n[4] The helper reports where it got to");

// The record of a pre-pipe death is the staging file, and it must open BEFORE the
// first thing that can fail. That was the gap: DiagLog.Start used to sit after the
// --pipe check, so a helper that returned early left nothing at all.
const startIdx = helper.indexOf('DiagLog.Start("helper"');
const pipeCheckIdx = helper.indexOf('IsNullOrWhiteSpace(pipe)');
const openDesktopIdx = helper.indexOf("OpenDesktop(");
check("DiagLog.Start runs before the --pipe check", startIdx > 0 && startIdx < pipeCheckIdx);
check("DiagLog.Start runs before the first Win32 call", startIdx > 0 && startIdx < openDesktopIdx);
check('the helper logs "HELPER ENTRY REACHED" as its first record', /HELPER ENTRY REACHED/.test(helper));
check("the helper logs its parsed args", /ARGS PARSED/.test(helper));

check("a startup exception is caught and its type, message and stack are logged",
  /catch \(Exception ex\)[\s\S]{0,400}helper\.crash[\s\S]{0,200}ex\.GetType\(\)\.FullName[\s\S]{0,200}ex\.StackTrace/.test(helper));
check("a caught startup exception returns a distinct, non-zero code",
  /helper\.crash[\s\S]{0,400}return 99;/.test(helper));

// The distinct early-return codes are what the watcher's exit code now maps to.
for (const [what, codeVal] of [["missing pipe", 87], ["OpenDesktop failed", 2], ["SetThreadDesktop failed", 3], ["pipe connect failed", 4]]) {
  check(`distinct exit code ${codeVal} for: ${what}`, new RegExp(`return ${codeVal};`).test(helper));
}

/* --- 5. real exit code, not "?" -------------------------------------------- */
console.log("\n[5] The watcher reads the real exit code");

check("the watcher keeps the CreateProcess handle instead of closing it",
  /_helperHandle = info\.hProcess/.test(watcher) &&
  !/CloseHandle\(info\.hProcess\)/.test(watcher));
check("it reads the exit code with GetExitCodeProcess, not Process.ExitCode by pid",
  /GetExitCodeProcess\(_helperHandle/.test(watcher) && !/Process\.GetProcessById/.test(watcher));
check("the exit code is logged with its human-readable meaning",
  /exitCode=\{code\}[\s\S]{0,40}Describe\(\(int\)code\)/.test(watcher));
check('exitCode=? is gone', !/exitCode=\?/.test(watcher) && !/exitCode=\{SafeExitCode/.test(watcher));
check("helper lifetime is measured, so a rapid failure is distinguishable from a real teardown",
  /_helperStartedUtc/.test(watcher) && /lifetimeMs=/.test(watcher));

/* --- 6. bounded restart, not a 300ms loop ---------------------------------- */
console.log("\n[6] Crash-loop protection");

check("there is a ceiling on rapid restarts", /MaxRapidFailures/.test(watcher));
check("a helper that dies fast counts as a rapid failure",
  /RapidFailureWindow/.test(watcher) && /lifetime < RapidFailureWindow/.test(watcher));
check("reaching the ceiling logs HELPER_STARTUP_FAILED and stops relaunching",
  /_rapidFailures >= MaxRapidFailures[\s\S]{0,200}HELPER_STARTUP_FAILED/.test(watcher) &&
  /_startupFailed = true/.test(watcher));
check("relaunch is gated on the ceiling and a backoff delay",
  /_helperHandle == IntPtr\.Zero && !_startupFailed && DateTime\.UtcNow >= _nextRetryUtc/.test(watcher));
check("the backoff grows with the failure count", /_nextRetryUtc = DateTime\.UtcNow\.AddMilliseconds\(250 \* _rapidFailures\)/.test(watcher));
check("a desktop change resets the failure state, so a new prompt is not pre-judged",
  /_rapidFailures = 0;\s*_startupFailed = false;\s*_nextRetryUtc = DateTime\.MinValue;/.test(watcher));

/* --- 7. no redundant helper on the applet's own desktop -------------------- */
console.log("\n[7] The Default desktop is the applet's job, not a helper's");

check("NeedsHelper is false for Default",
  /NeedsHelper\(string desktop\)[\s\S]{0,220}!string\.Equals\(desktop, "Default"/.test(watcher));
check("...and false for the 'may not open it' sentinel and the empty name",
  /NeedsHelper[\s\S]{0,220}desktop\.Length > 0[\s\S]{0,80}Desktops\.Denied/.test(watcher));
check("MaintainHelper stops any lingering helper when none is wanted",
  /if \(!NeedsHelper\(desktop\)\)[\s\S]{0,160}StopHelper\(\)/.test(watcher));
// The applet must still be told when the desktop returns to Default, or it never
// resumes its own capture. Announcing is independent of launching a helper.
check("the watcher still announces every desktop change, including back to Default",
  /link\?\.AnnounceDesktop\(desktop\)/.test(watcher));

report("desktop helper startup");
