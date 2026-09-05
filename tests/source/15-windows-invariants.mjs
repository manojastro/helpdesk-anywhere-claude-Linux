/**
 * Invariants in the Windows half that neither the compiler nor Linux can check.
 *
 * Everything under `windows/` cross-compiles here and runs nowhere here, so the
 * only automated grip on it is the compiler — and the compiler is happy with a
 * pipe path that throws at runtime, a service that starts at boot, or a password
 * on its way into a log. Each check below is tied to a specific constraint in
 * CLAUDE.md or a specific line of PLAN.md, and most of them exist because the
 * thing they assert was once wrong.
 *
 * This is a backstop for MT-06, not a substitute for it.
 */
import { readFileSync } from "node:fs";
import { check, report, REPO } from "../lib/harness.mjs";

const read = (p) => readFileSync(`${REPO}/${p}`, "utf8");
/** Source with comments stripped — an invariant must hold in code, not prose. */
const code = (p) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\/\/\/.*$/gm, "");

console.log("\n=== Windows source invariants (cannot be executed on Linux) ===\n");

/* --- constraint #4: nothing survives the session ---------------------------- */
console.log("[C4] No persistence — the service is temporary by construction");

const serviceControl = code("windows/Applet/Elevation/ServiceControl.cs");
const advapi = code("windows/Applet/Interop/AdvApi32.cs");

check("the service is created SERVICE_DEMAND_START, never auto-start",
  serviceControl.includes("SERVICE_DEMAND_START") &&
  !/SERVICE_AUTO_START/.test(serviceControl + advapi));

check("uninstall deletes the staging directory as well as the registration",
  /DeleteService/.test(serviceControl) && /Directory\.Delete/.test(serviceControl));

const svcProgram = code("windows/SecureDesktopService/Program.cs");
check("the service self-uninstalls rather than deferring cleanup to a reboot",
  /sc delete/.test(svcProgram) && !/MOVEFILE_DELAY_UNTIL_REBOOT/.test(svcProgram));

check("…on a watchdog timeout AND on the applet's explicit request",
  /_selfUninstall = true/.test(svcProgram) && /SessionOver/.test(svcProgram));

const appletProgram = code("windows/Applet/Program.cs");
check("every applet exit path reaches Teardown, and Teardown removes the service",
  ["ProcessExit", "UnhandledException", "ThreadException", "CancelKeyPress", "SessionEnding"]
    .every((h) => appletProgram.includes(h)) &&
  /_elevation, null\)\?\.Shutdown\(\)/.test(appletProgram));

console.log("\n[C2] Teardown order — the promises, strongest first");

const finish = appletProgram + code("windows/Applet/AppletContext.cs");
for (const [where, body] of [
  ["AppletContext.Finish", code("windows/Applet/AppletContext.cs").split("private async void Finish")[1] ?? ""],
  ["Program.Teardown", appletProgram.split("internal static void Teardown")[1] ?? ""],
]) {
  const stopStream = body.search(/_streamer,? null\)?\??\.(Dispose|Stop)|_streamer\?\.Dispose/);
  const release = body.search(/ReleaseAll/);
  const scripts = body.search(/_scripts.{0,20}Dispose/);
  check(`${where} stops capture before anything else`,
    stopStream >= 0 && stopStream < release && release < scripts,
    "not one more frame of the user's screen may leave after End Session");
}
check("teardown is reachable from a crash path, not only the polite one",
  /UnhandledException/.test(finish) && /Program\.Teardown\(\)/.test(finish));

/* --- the watchdog's one input ---------------------------------------------- */
console.log("\n[C4] The watchdog's pipe check must address the real namespace");

const pipeChannel = code("windows/Shared/PipeChannel.cs");
// Two leading backslashes and a trailing one: the Win32 device path, not a
// path relative to the current drive.
const PIPE_NAMESPACE = ['@"', "\\", "\\", ".", "\\", "pipe", "\\", '"'].join("");
check("the pipe namespace is the Win32 device path, not a drive-relative one",
  pipeChannel.includes(PIPE_NAMESPACE),
  "a wrong path throws, SafeExists reads a throw as present, and the backstop never fires");

check("there is also a lifetime ceiling, so a permanently broken check still ends",
  /MaxServiceLifetime/.test(svcProgram));

/* --- constraint #6: credentials never logged or retained -------------------- */
console.log("\n[C6] Credential handling");

const manager = code("windows/Applet/Elevation/ElevationManager.cs");
check("the password buffer is zeroed in a finally", /finally[\s\S]{0,200}Zero\(password\)/.test(manager));
check("the unmanaged copy is zeroed BEFORE it is freed",
  manager.indexOf("Marshal.WriteInt16(unmanaged, i * sizeof(char), 0)") <
  manager.indexOf("Marshal.FreeHGlobal"));
check("no password ever reaches a console or a log from the elevation path",
  !/Console\.(Write|Error)/.test(manager));
check("the wire record redacts the password in ToString",
  /\[redacted\]/.test(code("windows/Shared/Protocol.cs")));
check("the failure message is built from a Win32 code, never an exception message",
  /ElevationErrors\.Describe\(ex\.NativeErrorCode\)/.test(manager));

const errors = read("windows/Applet/Elevation/ElevationErrors.cs");
check("error mapping takes an int and a username — a password cannot reach it",
  !/password\s*[,)]/i.test(errors.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")));

/* --- constraint #2: the user always knows ---------------------------------- */
console.log("\n[C2] Elevation is surfaced on the user's own indicator");

check("the user is told BEFORE the bootstrap is attempted, not after it succeeds",
  manager.indexOf('_notifyUser("The agent is elevating') < manager.indexOf("Task.Run"));

const appletContext = code("windows/Applet/AppletContext.cs");
check("a SYSTEM script notice follows the dispatch, so it cannot claim a refusal ran",
  /TrySendExec\(json\) == true\)\s*\{\s*[\s\S]{0,400}?ShowNotice/.test(appletContext));
// The shape changed for MT-06 — the ternary became a state machine — but the
// property has not: every desktop transition reaches BOTH the console and the
// user's own indicator. Constraint #2 is that the user always knows.
check("a desktop switch is surfaced to the user as well as to the agent",
  /HostDesktopChanged/.test(appletContext) &&
  /OnStreamSourceChanged[\s\S]{0,1200}?ShowNotice\(notice\)/.test(appletContext));

/* --- PLAN 5.3 / 5.4: the two documented ways to get this wrong -------------- */
console.log("\n[5.3] Desktop and token handling");

const watcher = code("windows/SecureDesktopService/DesktopWatcher.cs");
check("lpDesktop always carries the window-station prefix",
  watcher.includes("WinSta0" + "\\"),
  "a bare desktop name fails with a desktop error and nothing that names the cause");
check("the SYSTEM token is moved into the console session before use",
  /SetTokenInformation/.test(watcher) && /WTSGetActiveConsoleSessionId/.test(watcher));
check("the duplicate is a primary token at impersonation level, not identification",
  /SecurityImpersonation, SessionLaunch.TokenPrimary/.test(watcher));

const helper = code("windows/DesktopHelper/Program.cs");
check("SetThreadDesktop runs before anything that creates a DC or a bitmap",
  helper.indexOf("SetThreadDesktop") < helper.indexOf("new GdiCapture()"));

check("Ctrl+Alt+Del goes to SendSAS, never to a synthesised key chord",
  /SendSAS/.test(helper) && !/VK_DELETE|0x2E/.test(helper));

/* --- PLAN 5.5: the pipe is not world-writable ------------------------------ */
console.log("\n[5.5] Pipe and staging ACLs");

check("the pipe admits LocalSystem and the session's own user, and nobody else",
  /LocalSystemSid/.test(pipeChannel) && /identity.User/.test(pipeChannel) &&
  !/WorldSid|Everyone|AuthenticatedUser/.test(pipeChannel));

const payload = code("windows/Applet/Elevation/ElevationPayload.cs");
check("the staging directory is created with a protected, non-inherited DACL",
  /SetAccessRuleProtection\(\s*isProtected:\s*true/.test(payload));
check("…and an inherited-permissions directory left by someone else is removed, not reused",
  /Directory\.Delete\(dir, recursive: true\)/.test(payload));
check("…admitting only LocalSystem and Administrators",
  /LocalSystemSid/.test(payload) && /BuiltinAdministratorsSid/.test(payload) &&
  !/WorldSid|AuthenticatedUser|BuiltinUsersSid/.test(payload));

report("windows source invariants");
