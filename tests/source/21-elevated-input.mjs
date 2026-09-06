/**
 * Post-UAC elevated input on WinSta0\Default — MT-06 STATE C.
 *
 * Real Windows, 2026-09-06: the Secure Desktop now works end to end. The genuine
 * UAC prompt appears in the technician canvas, the remote mouse reaches it, and a
 * remote click on Yes is accepted. What then fails is the application UAC just
 * launched: it runs at HIGH integrity on the ordinary Default desktop, and the
 * applet's own SendInput — MEDIUM integrity by design, because the applet must
 * never self-elevate (CLAUDE.md constraint #1) — is silently discarded by Windows
 * UIPI.
 *
 * Three states, deliberately kept apart, because conflating the last two is how
 * this gets misdiagnosed:
 *   A  Default desktop, ordinary window   -> applet or helper may inject
 *   B  Winlogon secure desktop            -> secure-desktop helper (already working)
 *   C  Default desktop, elevated window   -> needs an injector above medium integrity
 *
 * These assert the routing, the diagnostics that prove UIPI, and that STATE B is
 * not disturbed. Only Windows can prove a click lands.
 */
import { readFileSync } from "node:fs";
import { check, report, REPO } from "../lib/harness.mjs";

const read = (p) => readFileSync(`${REPO}/${p}`, "utf8");
const code = (p) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\/\/\/.*$/gm, "");

const context = code("windows/Applet/AppletContext.cs");
const watcher = code("windows/SecureDesktopService/SessionWatcher.cs");
const helper = code("windows/DesktopHelper/Program.cs");
const injector = code("windows/Applet/Input/InputInjector.cs");
const foreground = code("windows/Applet/Interop/ForegroundTarget.cs");
const bounds = code("windows/Applet/Capture/ScreenBounds.cs");
const bridge = code("windows/Applet/Elevation/SecureDesktopBridge.cs");

console.log("\n=== Post-UAC elevated input on the Default desktop (MT-06 STATE C) ===\n");

/* --- 1. an injector that can actually reach an elevated window ------------- */
console.log("[1] There is an elevated injector on the user's own desktop");

check("the watcher now keeps a helper on every real desktop, Default included",
  /NeedsHelper\(string desktop\) =>\s*desktop\.Length > 0 && desktop != Desktops\.Denied;/.test(watcher));
check("...and the Default one is launched --input-only",
  /IsInputOnly\(desktop\) \? " --input-only" : ""/.test(watcher) &&
  /--desktop-helper --desktop \{desktop\} --pipe \{_pipeName\}\{inputOnly\}/.test(watcher));
check("input-only means Default, and only Default",
  /IsInputOnly\(string desktop\) =>\s*string\.Equals\(desktop, "Default", StringComparison\.OrdinalIgnoreCase\)/.test(watcher));

// The elevated helper runs as SYSTEM in the interactive session on the same
// desktop -- above both medium and high integrity, so UIPI accepts its input for
// ordinary and elevated windows alike. Session 0 must never inject into session 5.
check("the helper is still launched into the interactive session, never from session 0",
  /CreateProcess\(/.test(watcher) && /lpDesktop = \$@"WinSta0\\\{desktop\}"/.test(watcher) &&
  !/CreateProcessAsUser/.test(watcher));

/* --- 2. input-only must not become a second capturer ---------------------- */
console.log("\n[2] The Default helper injects and does not capture");

check("the helper honours --input-only", /args\.Contains\("--input-only"\)/.test(helper));
check("...and creates no capture surfaces in that mode",
  /IScreenCapture capture = inputOnly \? new ScreenBounds\(\) : new GdiCapture\(\)/.test(helper));
check("...and starts no ScreenStreamer in that mode",
  /if \(!inputOnly\)\s*\{[\s\S]{0,220}new ScreenStreamer\(capture, sink\)/.test(helper));
check("ScreenBounds answers geometry and refuses to grab a frame",
  /Bitmap\? Grab\(\) => null;/.test(bounds) && /GdiCapture\.ReadVirtualScreen\(\)/.test(bounds));
check("...and reads the geometry live, so a resolution change cannot misplace clicks",
  /Rectangle VirtualScreen => GdiCapture\.ReadVirtualScreen\(\);/.test(bounds));

/* --- 3. exactly one injector per event ------------------------------------ */
console.log("\n[3] Exactly one injector handles each event");

check("the helper is tried first and the local injector only on its failure",
  /var viaHelper = _bridge\?\.TrySendInput\(json\) == true;[\s\S]{0,300}if \(viaHelper\) return;\s*_injector\?\.Handle\(input\);/.test(context));
check("TrySendInput reports false when no helper is attached, so the fallback is real",
  /TrySendInput\(string json\) =>\s*_helper\?\.Post\(/.test(bridge));
check("the watcher keeps at most one helper alive, so only one can be attached",
  /StopHelper\(\);\s*_current = desktop;/.test(watcher));

/* --- 4. the diagnostics that prove UIPI ----------------------------------- */
console.log("\n[4] Proving UIPI rather than guessing at it");

check("SendInput's return value is no longer discarded",
  /var sent = Interop\.Input\.SendInput\(/.test(injector) && /SendAttempted\+\+/.test(injector));
check("a refused injection records the Win32 error",
  /if \(sent == 0\)[\s\S]{0,200}LastSendError = System\.Runtime\.InteropServices\.Marshal\.GetLastWin32Error\(\)/.test(injector));
check("...and is surfaced once, not per event",
  /DeliveryChanged/.test(injector) && /if \(_delivering\)/.test(injector));
check("both the applet and the helper listen for a refused injection",
  /_injector\.DeliveryChanged \+=/.test(context) && /injector\.DeliveryChanged \+=/.test(helper));

check("the foreground target's pid, name, integrity and elevation are readable",
  ["GetForegroundWindow", "GetWindowThreadProcessId", "OpenProcessToken", "TokenIntegrityLevel", "TokenElevation"]
    .every((api) => foreground.includes(api)));
check("integrity is compared against the applet's own medium level",
  /AboveMediumIntegrity => Known && IntegrityRid > IntegrityMedium/.test(foreground));
check("an unreadable target is 'cannot tell', never 'elevated'",
  /return new Info\(false,/.test(foreground) && /Known/.test(foreground));
check("the target is queried read-only: query-limited process, query-only token",
  /PROCESS_QUERY_LIMITED_INFORMATION = 0x1000/.test(foreground) && /TOKEN_QUERY = 0x0008/.test(foreground));

check("the route is logged on change, not per event",
  /if \(route == _lastInputRoute && _foreground\.Pid == _lastForegroundPid\) return;/.test(context));
check("the three routes are distinguished by name",
  ["SECURE_DESKTOP_INPUT", "ELEVATED_DEFAULT_INPUT", "NORMAL_DEFAULT_INPUT"].every((r) => context.includes(r)));
check("an elevated target with no elevated route says so explicitly",
  /UIPI WILL REFUSE THIS INPUT/.test(context));
check("...and tells the user on their own indicator, once",
  /_warnedUipi/.test(context) && /ShowNotice\(/.test(context));

/* --- 5. nothing about the event itself is logged (constraint #6) ---------- */
console.log("\n[5] Diagnostics never carry the input itself");

const inputLogs = [...context.matchAll(/DiagLog\.\w+\("applet\.input"[^;]*;/g)].map((m) => m[0]).join("\n") +
  [...helper.matchAll(/DiagLog\.\w+\("helper\.input"[^;]*;/g)].map((m) => m[0]).join("\n");
check("no input diagnostic logs keys, text, or coordinates",
  !/\b(input\.Text|input\.Key|input\.X|input\.Y|json)\b/.test(inputLogs), inputLogs.slice(0, 160));
check("the raw input json is never written to the log",
  !/DiagLog\.[A-Za-z]+\([^;]*\bjson\b/.test(context));

/* --- 6. STATE B must not regress ----------------------------------------- */
console.log("\n[6] The working Secure Desktop path is untouched");

check("a secure desktop still gets a capturing helper",
  /IsInputOnly\(string desktop\)[\s\S]{0,200}"Default"/.test(watcher));
check("Ctrl+Alt+Del still goes to SendSAS via the helper",
  /input\.Kind == "sas"[\s\S]{0,120}_bridge\?\.TrySendSas\(\)/.test(context));
check("the secure-desktop route is still reported as its own state",
  /_source\.State == StreamSourceState\.SecureDesktop/.test(context));
check("helper restart backoff and the startup ceiling are still in place",
  /MaxRapidFailures/.test(watcher) && /HELPER_STARTUP_FAILED/.test(watcher));
check("the desktop bind decision from the previous fix is untouched",
  /DESKTOP_ALREADY_BOUND/.test(helper) && /DESKTOP_VERIFIED/.test(helper));

/* --- 7. nothing weakens the boundary ------------------------------------- */
console.log("\n[7] The UIPI boundary is crossed by privilege, not by disabling it");

const all = [context, watcher, helper, injector, foreground].join("\n");
for (const [what, re] of [
  ["disable UIPI", /uiAccess\s*=\s*"true"|EnableLUA|ChangeWindowMessageFilter/i],
  ["lower the target's integrity", /SetTokenInformation[^;]*Integrity|TokenIntegrityLevel[^;]*Set/i],
  ["install a global hook", /SetWindowsHookEx/i],
  ["auto-click anything", /auto.?click/i],
  ["change security policy", /Set-ItemProperty|ConsentPromptBehavior|reg add/i],
]) {
  check(`does not ${what}`, !re.test(all));
}
check("the applet manifest still asks for asInvoker only",
  /level="asInvoker"/.test(read("windows/Applet/app.manifest")) &&
  /uiAccess="false"/.test(read("windows/Applet/app.manifest")));
check("the privileged pipe still admits only LocalSystem and the session's own user",
  /LocalSystemSid/.test(code("windows/Shared/PipeChannel.cs")) &&
  !/WorldSid|Everyone|AuthenticatedUser/.test(code("windows/Shared/PipeChannel.cs")));

report("post-UAC elevated input");
