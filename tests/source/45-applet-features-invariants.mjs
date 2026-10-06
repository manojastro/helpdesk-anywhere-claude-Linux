/**
 * Platform 2.0 Phase 2b — properties of the new applet code that a compiler
 * cannot see and no Linux test can run (the Windows half executes nowhere here).
 *
 *   1. The feature code stays beside the verified control path: it never touches
 *      capture, input injection, the desktop watch or elevation.
 *   2. Every filesystem path from the wire goes through PathPolicy before any I/O.
 *   3. Uploads never overwrite (CreateNew, overwrite:false, unique names) and
 *      land as .hdapart until verified; deletes are never recursive.
 *   4. The customer is told: every transfer, change and clipboard access notifies
 *      the indicator.
 *   5. Clipboard text is never logged; nothing in Features logs at all.
 *   6. Lifecycle: features start only after consent (inside StartRemoteControl),
 *      only take messages after consent, and are disposed at teardown, after
 *      scripts and before the elevated service is removed.
 *   7. Script cancel reaches only scripts this runner started.
 */
import { readFileSync, readdirSync } from "node:fs";

import { REPO, check, report } from "../lib/harness.mjs";

const read = (p) => readFileSync(`${REPO}/${p}`, "utf8");
const dir = "windows/Applet/Features";
const files = Object.fromEntries(readdirSync(`${REPO}/${dir}`).map((f) => [f, read(`${dir}/${f}`)]));
const all = Object.values(files).join("\n");
const ctx = read("windows/Applet/AppletContext.cs");
const runner = read("windows/Applet/Scripting/ScriptRunner.cs");
const strip = (s) => s.replace(/\/\/\/.*$|\/\/.*$/gm, "");

console.log("\n=== Applet feature invariants (Phase 2b) ===\n");

/* 1 */
check("feature code never references capture, input, desktop watch or elevation",
  !/\b(GdiCapture|ScreenStreamer|StreamSource|DesktopGuard|InputInjector|SendInput|SecureDesktopBridge|ElevationManager|ServiceControl|PipeChannel|OpenInputDesktop|SetThreadDesktop)\b/.test(strip(all)));
check("feature code has no P/Invoke of its own (Interop/ only)", !/DllImport|LibraryImport/.test(all));
check("feature code never starts a process", !/Process\.Start|ProcessStartInfo/.test(strip(all)));

/* 2 */
const fs = strip(files["FileService.cs"]);
for (const fn of ["Mkdir", "Rename", "Delete"]) {
  const body = fs.slice(fs.indexOf(`public static HostFsResult ${fn}(`), fs.indexOf("public static HostFsResult", fs.indexOf(`public static HostFsResult ${fn}(`) + 10) >>> 0 || undefined);
  check(`FileService.${fn} canonicalises the path before any I/O`,
    body.indexOf("PathPolicy.Canonical(") > 0 && body.indexOf("PathPolicy.Canonical(") < Math.min(...["File.", "Directory."].map((k) => body.indexOf(k)).filter((i) => i > 0)));
}
const list = fs.slice(fs.indexOf("public static HostFsResult List("), fs.indexOf("private static HostFsResult ListRoots"));
check("FileService.List canonicalises before opening the folder", list.indexOf("PathPolicy.Canonical(") < list.indexOf("new DirectoryInfo("));
const tm = strip(files["TransferManager.cs"]);
const up = tm.slice(tm.indexOf("public void BeginUpload"), tm.indexOf("public void Chunk"));
check("an upload's folder and name are validated before the file is created",
  up.indexOf("PathPolicy.Canonical(") > 0 && up.indexOf("PathPolicy.IsValidName(") > 0 && up.indexOf("PathPolicy.IsValidName(") < up.indexOf("new FileStream("));
const down = tm.slice(tm.indexOf("public void BeginDownload"), tm.indexOf("private async Task SendFileAsync"));
check("a download's path is validated before it is opened", down.indexOf("PathPolicy.Canonical(") > 0 && down.indexOf("PathPolicy.Canonical(") < down.indexOf("File.Exists("));

/* 3 */
check("uploads open with FileMode.CreateNew only", /FileMode\.CreateNew/.test(tm) && !/FileMode\.(Create|OpenOrCreate|Truncate|Append)\b/.test(tm));
check("nothing in Features moves with overwrite: true", !/overwrite:\s*true/.test(all));
check("uploads are written as .hdapart and renamed only after the hash check",
  /\.hdapart/.test(tm) && tm.indexOf("GetHashAndReset") < tm.indexOf("File.Move(u.PartPath"));
check("a failed or cancelled upload deletes its partial file", (tm.match(/TryDelete\(u\.PartPath\)/g) ?? []).length >= 3);
check("deletes are never recursive", /Directory\.Delete\(target, recursive: false\)/.test(fs) && !/recursive:\s*true/.test(all));
check("a drive root can be neither renamed nor deleted", /PathPolicy\.IsRoot\(source\)/.test(fs) && /PathPolicy\.IsRoot\(target\)\) return Fail\(rid, "delete"/.test(fs));
check("downloads are read-only", /FileAccess\.Read,/.test(tm) && !/FileAccess\.(Write|ReadWrite)[^,]*\)[^;]*SendFileAsync/.test(tm));
check("downloads wait on an ack window", /await d\.Window\.WaitAsync/.test(tm) && /FeatureProtocol\.Window/.test(tm));

/* 4 */
const host = strip(files["FeatureHost.cs"]);
check("uploads and downloads tell the customer", (tm.match(/_notifyUser\(/g) ?? []).length >= 4);
check("folder changes tell the customer", /Announce\(FileService\.(Mkdir|Rename|Delete)/.test(host) && /_notifyUser\(\$"The technician \{verb\}/.test(host));
check("clipboard set and get both tell the customer",
  /put text on your clipboard/.test(host) && /copied the text on your clipboard/.test(host));

/* 5 */
check("nothing in Features writes a diagnostic log", !/DiagLog/.test(all));
check("clipboard records redact their text in ToString", /Text = \[redacted\]/.test(read("windows/Shared/ProtocolFeatures.cs")));

/* 6 */
const start = ctx.slice(ctx.indexOf("private void StartRemoteControl()"), ctx.indexOf("private void OnUnhandled("));
check("the feature host is created in StartRemoteControl (after consent)", /_features = new FeatureHost\(/.test(start));
check("…outside the capture try block, so either can fail alone", start.lastIndexOf("_features = new FeatureHost(") > start.indexOf("Screen sharing unavailable"));
const unhandled = ctx.slice(ctx.indexOf("private void OnUnhandled("), ctx.indexOf("/* --------------------------------------------------------------- elevation */"));
check("feature messages pass the consent/finished guard first",
  unhandled.indexOf("if (!_consented || _finished) return;") > 0 && unhandled.indexOf("if (!_consented || _finished) return;") < unhandled.indexOf("_features?.TryHandle("));
check("feature messages only reach the host as the switch default", /default:\s*\n\s*_features\?\.TryHandle\(type, json\);/.test(unhandled));
const finish = ctx.slice(ctx.indexOf("private async void Finish("));
const iScripts = finish.indexOf("_scripts?.Dispose()");
const iFeatures = finish.indexOf("_features?.Dispose()");
const iElev = finish.indexOf("_elevation?.Shutdown()");
check("teardown disposes features after scripts and before removing the elevated service",
  iScripts > 0 && iFeatures > iScripts && iElev > iFeatures);
check("teardown still stops pixels first", finish.indexOf("_streamer?.Dispose()") > 0 && finish.indexOf("_streamer?.Dispose()") < iScripts);

/* 7 */
const cancel = runner.slice(runner.indexOf("public bool Cancel(string id)"), runner.indexOf("private void SendFinal"));
check("cancel finds only scripts this runner started, by id", /_byId\.TryGetValue\(id, out process\)/.test(cancel) && /KillTree\(process\)/.test(cancel));
check("a cancelled script still reports through the normal final result", /\[stopped by the technician\]/.test(runner));

report("source/45 applet feature invariants");
