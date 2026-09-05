/**
 * The secure-desktop chain — MT-06's regression block.
 *
 * MT-06 failed on real Windows on 2026-09-05: elevation worked, the user clicked
 * Yes, and then a later UAC prompt turned the technician's canvas BLACK instead
 * of showing the Secure Desktop.
 *
 * The cause was one line in the wrong process. `DesktopWatcher` polled
 * `OpenInputDesktop` from inside the LocalSystem service, which runs in session 0.
 * That call resolves the input desktop of the CALLING PROCESS'S WINDOW STATION,
 * and window stations are per-session: a session-0 service is on
 * `Service-0x0-3e7$`, which has no input desktop at all. So the interactive
 * session's switch to `Winlogon` was invisible from there, no helper was ever
 * launched onto the Secure Desktop, the applet was never told to stop, and its own
 * capture kept running against a desktop that no longer owned the display — where
 * `BitBlt` SUCCEEDS and returns black.
 *
 * Every check below is a fact the compiler cannot see and Linux cannot execute,
 * tied to the specific way this broke. They are a backstop for MT-06, not a
 * substitute for it: only the Windows machine can prove the picture arrives.
 */
import { readFileSync } from "node:fs";
import { check, report, REPO } from "../lib/harness.mjs";

const read = (p) => readFileSync(`${REPO}/${p}`, "utf8");
/** Source with comments stripped — an invariant must hold in code, not prose. */
const code = (p) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\/\/\/.*$/gm, "");

console.log("\n=== Secure desktop: detection, launch, capture, routing (MT-06) ===\n");

const service = code("windows/SecureDesktopService/DesktopWatcher.cs");
const watcher = code("windows/SecureDesktopService/SessionWatcher.cs");
const helper = code("windows/DesktopHelper/Program.cs");
const capture = code("windows/Applet/Capture/GdiCapture.cs");
const guard = code("windows/Applet/Capture/DesktopGuard.cs");
const source = code("windows/Applet/Capture/StreamSource.cs");
const context = code("windows/Applet/AppletContext.cs");
const bridge = code("windows/Applet/Elevation/SecureDesktopBridge.cs");
const elevation = code("windows/Applet/Elevation/ElevationManager.cs");
const desktops = code("windows/Applet/Interop/Desktops.cs");
const entry = code("windows/Applet/Program.cs");

/* --- 1. the defect itself --------------------------------------------------- */
console.log("[1] Desktop detection happens where the answer exists");

check("the session-0 service does NOT call OpenInputDesktop — it cannot see the interactive desktop",
  !/OpenInputDesktop/.test(service));

check("the in-session watcher is the one that reads the input desktop",
  /InputDesktopName/.test(watcher));

check("…and it is launched as its own process mode, not run inside the service",
  /--desktop-watch/.test(service) && /--desktop-watch/.test(entry));

check("the service still does the one thing only session 0 can — cross the session boundary",
  /SetTokenInformation/.test(service) && /WTSGetActiveConsoleSessionId/.test(service) &&
  /CreateProcessAsUser/.test(service));

check("…and it targets the interactive session it just looked up, not a constant",
  /WTSGetActiveConsoleSessionId\(\)/.test(service) && /StartWatcher\(sessionId\)/.test(service));

check("the watcher launches helpers itself, from inside the session",
  /--desktop-helper/.test(watcher) && /CreateProcess\(/.test(watcher));

check("…with no token dance on the per-switch path — it is already SYSTEM in the session",
  !/DuplicateTokenEx|SetTokenInformation/.test(watcher));

/* --- 2. the desktop names on the wire --------------------------------------- */
console.log("\n[2] lpDesktop and the names that reach OpenDesktop");

// Every assignment of lpDesktop, in either process, must name the window station.
// A bare "Winlogon" fails with a desktop error that names nothing (PLAN 5.3).
// Only real assignments: `lpDesktop = @"…"` / `$@"…"`. The interpolations inside
// the diagnostic strings are not assignments and must not be mistaken for them.
const lpDesktopAssignments = [service, watcher, elevation]
  .flatMap((f) => [...f.matchAll(/lpDesktop\s*=\s*\$?@"([^"]+)"/g)].map((m) => m[1]));
check("every lpDesktop assignment carries the window-station prefix (PLAN 5.3)",
  lpDesktopAssignments.length >= 3 &&
  lpDesktopAssignments.every((v) => v.startsWith("WinSta0\\")),
  JSON.stringify(lpDesktopAssignments));

check("the service puts its watcher on WinSta0\\Default",
  /lpDesktop = \$@"WinSta0\\\{desktop\}"/.test(service) && /"Default", commandLine|StartWatcher/.test(service));

check("the watcher puts each helper on the desktop it just detected",
  lpDesktopAssignments.filter((v) => v === "WinSta0\\{desktop}").length >= 2);

check("the 'may not open it' sentinel is never passed to OpenDesktop as a name",
  // Since the MT-06 helper-startup fix this is enforced by NeedsHelper, which is
  // false for Denied, so StartHelper is never reached with it.
  /NeedsHelper\(string desktop\)[\s\S]{0,220}Desktops\.Denied/.test(watcher));

check("Denied is not a legal desktop name anywhere",
  /public const string Denied/.test(desktops) && /"<denied>"/.test(read("windows/Applet/Interop/Desktops.cs")));

/* --- 3. the helper still binds before it creates anything ------------------- */
console.log("\n[3] Helper ordering (PLAN 5.4) — unchanged, and still asserted");

check("SetThreadDesktop runs before anything that creates a DC or a bitmap",
  helper.indexOf("SetThreadDesktop") < helper.indexOf("new GdiCapture()"));

check("a failed OpenDesktop or SetThreadDesktop names the API and the Win32 error",
  // SetThreadDesktop now logs the captured error explicitly rather than through
  // DiagLog.Win32, because it is only reached on the branch that actually needs a
  // switch (MT-06: the unconditional call was the bug).
  /Win32\("helper\.desktop", "OpenDesktop"/.test(helper) &&
  /SET_THREAD_DESKTOP_FAILED/.test(helper) &&
  /win32Error=\{error\}/.test(helper));

check("Ctrl+Alt+Del still goes to SendSAS, never to a synthesised key chord",
  /SendSAS/.test(helper) && !/VK_DELETE|0x2E/.test(helper));

/* --- 4. black frames ------------------------------------------------------- */
console.log("[4] A capture that no longer owns the display sends nothing");

// Scoped to Grab's own body: OwnsDisplayNow also mentions the guard, and a check
// that the *file* mentions it somewhere before BitBlt would survive deleting the
// one call that matters.
const grabBody = capture.split("public Bitmap? Grab()")[1]?.split("private void DrawCursor")[0] ?? "";
check("Grab consults the desktop guard BEFORE BitBlt",
  grabBody.includes("_guard.OwnsDisplay()") &&
  grabBody.indexOf("_guard.OwnsDisplay()") < grabBody.indexOf("Gdi32.BitBlt"));

check("…and skips the frame rather than returning a black bitmap",
  /if \(!_guard\.OwnsDisplay\(\)\)\s*\{\s*SuppressedFrames\+\+;\s*return null;/.test(capture));

check("the guard is conservative: an unreadable input desktop means carry on",
  /_inputDesktop\.Length == 0 \|\| _ownDesktop\.Length == 0\) return true/.test(guard));

check("…and ERROR_ACCESS_DENIED is treated as a positive 'not mine', not an error",
  /Denied/.test(guard) && /ErrorAccessDenied/.test(desktops));

check("the guard caches, so a 10 FPS loop does not hammer OpenInputDesktop",
  /CacheFor/.test(guard) && /_readAt/.test(guard));

/* --- 5. the frame-source state machine -------------------------------------- */
console.log("\n[5] Exactly one source may send, in every state");

for (const state of ["DefaultDesktop", "SecureDesktopTransition", "SecureDesktop", "ReturningToDefault"]) {
  check(`state ${state} exists`, new RegExp(`\\b${state}\\b`).test(source));
}

check("neither source sends during the transition into a secure desktop",
  /\(false, false\) => StreamSourceState\.SecureDesktopTransition/.test(source) &&
  /LocalMaySend[\s\S]{0,300}DefaultDesktop or StreamSourceState\.ReturningToDefault/.test(source) &&
  /HelperMaySend[\s\S]{0,160}_state == StreamSourceState\.SecureDesktop/.test(source));

check("helper frames are dropped unless the machine says the helper owns the canvas",
  /if \(!_source\.HelperMaySend\) return;/.test(context));

check("local capture is paused from the machine, not from a raw desktop string",
  /_streamer\?\.SetPaused\(!_source\.LocalMaySend\)/.test(context));

check("the applet observes the input desktop itself rather than waiting for a helper",
  /StartDesktopPoll/.test(context) && /_source\.ObserveDisplay/.test(context));

check("…on a timer that is stopped and disposed on teardown",
  /_desktopPoll\?\.Stop\(\)/.test(context) && /_desktopPoll = null/.test(context));

check("a failed elevation resets the machine, so a stale secure state cannot freeze the canvas",
  /_source\.Reset\(\)/.test(context));

/* --- 6. elevation means usable, not installed ------------------------------- */
console.log("\n[6] Elevation is reported only once the SYSTEM half works");

check("ServiceControl can answer 'running', not just 'registered'",
  /public static bool IsRunning/.test(code("windows/Applet/Elevation/ServiceControl.cs")));

check("success waits for service RUNNING + pipe attached + watcher attached",
  /WaitUntilUsable/.test(elevation) &&
  /ServiceControl\.IsRunning\(\)/.test(elevation) &&
  /_serviceAttached\(\)/.test(elevation) &&
  /_watcherAttached\(\)/.test(elevation));

check("…and WaitUntilUsable runs before Elevated is set",
  elevation.indexOf("WaitUntilUsable();") < elevation.indexOf("Elevated = true;"));

check("a timeout names which precondition never became true",
  /never connected to the applet/.test(elevation) && /never started in your session/.test(elevation));

check("the applet supplies both probes from the bridge",
  /_bridge\?\.ServiceAttached == true/.test(context) && /_bridge\?\.WatcherAttached == true/.test(context));

/* --- 7. the watcher is not a helper ---------------------------------------- */
console.log("\n[7] Roles on the shared pipe");

check("the bridge tracks the watcher separately from the helper",
  /RoleWatcher\) _watcher = endpoint/.test(bridge));

check("…so input is never routed to a process that injects nothing",
  /TrySendInput[\s\S]{0,200}_helper\?\.Post/.test(bridge) && !/_watcher\?\.Post\(PipeChannel\.TextFrame\(PipeChannel\.TagInput/.test(bridge));

check("teardown tells the watcher to go as well as the helper and the service",
  /_helper\?\.PostBlocking[\s\S]{0,120}_watcher\?\.PostBlocking[\s\S]{0,120}_service\?\.PostBlocking/.test(bridge));

check("the pipe still admits only LocalSystem and the session's own user",
  /LocalSystemSid/.test(code("windows/Shared/PipeChannel.cs")) &&
  !/WorldSid|Everyone|AuthenticatedUser/.test(code("windows/Shared/PipeChannel.cs")));

/* --- 8. diagnostics, and what may never be in them -------------------------- */
console.log("\n[8] Diagnostics (constraint #6: never a credential)");

const diag = code("windows/Shared/DiagLog.cs");

check("every stage of the chain logs",
  ["applet.elevate", "applet.bootstrap", "service.start", "service.launch",
   "watcher.start", "watcher.detect", "watcher.launch", "helper.desktop",
   "helper.pipe", "helper.capture", "applet.source"]
    .every((stage) =>
     [elevation, service, watcher, helper, context, source,
      code("windows/SecureDesktopService/Program.cs")].some((f) => f.includes(stage))));

check("failed Win32 calls log the API, the number and a description",
  /public static void Win32\(string stage, string api, int error/.test(diag) &&
  /Describe\(error\)/.test(diag));

// The one thing that must never reach a log. Checked as a property of the call
// sites, not of the logger: a logger cannot tell a password from any other string.
const everySource = [elevation, context, service, watcher, helper, bridge, source, diag].join("\n");
check("no DiagLog call site passes a password, credential or keystroke",
  !/DiagLog\.[A-Za-z]+\([^;]*\b(password|Password|passwd|credential|Credential|secret|token(?!SessionId|Session)|Keystroke|keystroke)\b/.test(everySource));

check("the elevation manager still zeroes the password and never logs the username's password",
  /Zero\(password\)/.test(elevation) && !/DiagLog[^;]*password/.test(elevation));

check("script text is never logged",
  !/DiagLog\.[A-Za-z]+\([^;]*\b(script|Script|Command|command)\b/.test(everySource));

check("the log is size-capped so a loop cannot fill the disk",
  /MaxFileBytes/.test(diag) && /MaxBufferedLines/.test(diag));

check("diagnostics never break a session: every write path swallows its own failure",
  /catch \(Exception\)/.test(diag));

/* --- 9. constraint #4 is unchanged ------------------------------------------ */
console.log("\n[9] Nothing new survives the session");

check("the service kills its watcher with the process tree, and the watcher terminates its helper",
  // The service (DesktopWatcher) still tree-kills the watcher — which owns a
  // helper. The watcher terminates its single childless helper by handle
  // (TerminateProcess) rather than Process.Kill, since the MT-06 exit-code fix.
  /entireProcessTree: true/.test(service) && /TerminateProcess\(handle/.test(watcher));

check("the service is still demand-start and still self-uninstalls",
  /SERVICE_DEMAND_START/.test(code("windows/Applet/Elevation/ServiceControl.cs")) &&
  /_selfUninstall = true/.test(code("windows/SecureDesktopService/Program.cs")));

check("the elevated processes' logs live inside the staging directory, which is deleted",
  /CommonApplicationData/.test(code("windows/Shared/DiagPaths.cs")) &&
  /"HelpdeskAnywhere", "logs"/.test(code("windows/Shared/DiagPaths.cs")));

report("secure desktop chain");
