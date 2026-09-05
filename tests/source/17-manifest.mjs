/**
 * The Windows application manifest — MT-01's regression block.
 *
 * MT-01 failed on the first real Windows run of HelpdeskAnywhere.exe: the
 * process died in the loader, before Main, with "the application has failed to
 * start because its side-by-side configuration is incorrect". sxstrace blamed
 * an XML syntax error in the embedded manifest, and it was right — a comment in
 * windows/Applet/app.manifest named a command-line switch with its two leading
 * hyphens, and XML 1.0 section 2.5 forbids a double hyphen inside a comment.
 *
 * The reason it shipped is the interesting part, and the reason this file
 * exists. MSBuild's <ApplicationManifest> does not parse the manifest; it copies
 * the bytes into the RT_MANIFEST resource. So the whole Linux side — compile,
 * publish, every block in this suite — was happy, and only Windows' loader,
 * which does parse it, ever objected. There was no automated check anywhere
 * between the file and a human on a Windows VM.
 *
 * Three layers of check below:
 *   1. the source manifest is well-formed and says what it must say;
 *   2. the manifest actually embedded in the built .exe is too, and is the same
 *      bytes — a source-only check would miss a build step that damaged it;
 *   3. the validator genuinely rejects each defect, including the real one,
 *      replayed from git. A green check that cannot go red is not a test.
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { check, report, REPO } from "../lib/harness.mjs";
import {
  parseXml, validateManifest, readPeManifest, IMAGE_FILE_MACHINE_AMD64,
} from "../lib/manifest.mjs";

const SOURCE = `${REPO}/windows/Applet/app.manifest`;
const EXE = `${REPO}/server/public/download/HelpdeskAnywhere.exe`;

console.log("\n=== Windows application manifest (MT-01) ===\n");

/* --- 1. the source ---------------------------------------------------------- */
console.log("[1] Source manifest — windows/Applet/app.manifest");

const sourceBytes = readFileSync(SOURCE);
for (const r of validateManifest(sourceBytes, { where: "source" })) check(r.name, r.ok, r.detail);

// The csproj must actually point at the file this block validates, or the whole
// block is checking something the build does not ship.
const csproj = readFileSync(`${REPO}/windows/Applet/Applet.csproj`, "utf8");
check("Applet.csproj embeds this exact file via <ApplicationManifest>",
  /<ApplicationManifest>\s*app\.manifest\s*<\/ApplicationManifest>/.test(csproj));
check("it is the only manifest in the tree — nothing else can be embedded instead",
  execFileSync("git", ["ls-files", "*.manifest"], { cwd: REPO, encoding: "utf8" })
    .trim().split("\n").filter(Boolean).join() === "windows/Applet/app.manifest");

/* --- 2. the manifest that actually ships ------------------------------------ */
console.log("\n[2] Embedded manifest — the RT_MANIFEST resource in the built .exe");

if (!existsSync(EXE)) {
  console.log("  ⊘ server/public/download/HelpdeskAnywhere.exe not built — run scripts/build-windows.sh");
  console.log("    (the source checks above still ran; the build itself gates on this same validator)");
} else {
  const { machine, manifests } = readPeManifest(EXE);
  check("the .exe is a PE for x64", machine === IMAGE_FILE_MACHINE_AMD64, `machine 0x${machine.toString(16)}`);
  check("exactly one RT_MANIFEST resource is embedded", manifests.length === 1, `${manifests.length} found`);
  if (manifests.length === 1) {
    for (const r of validateManifest(manifests[0].bytes, { where: "embedded" })) check(r.name, r.ok, r.detail);
    check("the embedded manifest is byte-identical to the source — no build step altered it",
      Buffer.compare(manifests[0].bytes, sourceBytes) === 0,
      `${manifests[0].bytes.length} vs ${sourceBytes.length} bytes`);
  }
}

/* --- 3. the validator can fail ----------------------------------------------- */
console.log("\n[3] Negative cases — each defect is actually rejected");

const rejects = (label, xml) => {
  const results = validateManifest(Buffer.from(xml, "utf8"), { where: "x" });
  const bad = results.filter((r) => !r.ok);
  check(`rejects ${label}`, bad.length > 0, bad[0]?.name ?? "ACCEPTED IT");
};

const good = sourceBytes.toString("utf8");

// The real MT-01 defect, replayed from the commit that shipped it rather than
// reconstructed — this is the exact byte sequence that killed the applet.
let shipped = null;
try {
  shipped = execFileSync("git", ["show", "153e449:windows/Applet/app.manifest"], { cwd: REPO });
} catch { /* history rewritten or shallow clone; the synthetic case below still runs */ }
if (shipped) {
  const results = validateManifest(shipped, { where: "shipped" });
  const wf = results.find((r) => r.name.includes("well-formed"));
  check("rejects the manifest that actually shipped in 153e449 (MT-01's defect)",
    wf !== undefined && !wf.ok, wf?.detail ?? "");
  check("…and says why, at the right line", /line 7,.*double hyphen/.test(wf?.detail ?? ""), wf?.detail ?? "");
}

rejects("a double hyphen in a comment", good.replace("install-service switch", "the --install-service switch"));
rejects("an unterminated comment", good.replace("-->", ""));
rejects("a backslash-escaped quote from bad shell quoting", good.replace('level="asInvoker"', 'level=\\"asInvoker\\"'));
rejects("a literal \\n instead of a newline", good.replace("\n<assembly", "\\n<assembly"));
rejects("a UTF-8 byte-order mark", "﻿" + good);
rejects("an unquoted attribute value", good.replace('level="asInvoker"', "level=asInvoker"));
rejects("a duplicated attribute", good.replace('level="asInvoker"', 'level="asInvoker" level="requireAdministrator"'));
rejects("a bare ampersand in element text", good.replace("permonitorv2<", "permonitor&v2<"));
rejects("a bare ampersand in an attribute value", good.replace('name="HelpdeskAnywhere.Applet"', 'name="Helpdesk&Anywhere"'));
rejects("a raw ]]> in element text", good.replace("permonitorv2<", "permonitorv2]]><"));
rejects("an unclosed element", good.replace("</trustInfo>", ""));
rejects("a mismatched end tag", good.replace("</security>", "</securrity>"));
rejects("a wrong namespace on <assembly>", good.replace("urn:schemas-microsoft-com:asm.v1", "urn:schemas-microsoft-com:asm.v9"));
rejects("an unknown requestedExecutionLevel", good.replace('level="asInvoker"', 'level="asAdministrator"'));
rejects("a 32-bit processorArchitecture on an x64-only applet", good.replace('processorArchitecture="amd64"', 'processorArchitecture="x86"'));
rejects("a malformed assemblyIdentity version", good.replace('version="1.0.0.0"', 'version="1.0"'));
rejects("a second XML declaration", good + '<?xml version="1.0"?>');
rejects("an undeclared namespace prefix", good.replace("<security>", "<foo:security>").replace("</security>", "</foo:security>"));

// Constraint #1 is not a style preference: a manifest that asks for elevation
// puts a UAC prompt in front of the end user before the consent dialog exists.
rejects("silently switching the applet to requireAdministrator",
  good.replace('level="asInvoker"', 'level="requireAdministrator"'));

// …and the parser must not reject things that are legal, or it will block a
// future edit for no reason.
const accepts = (label, xml) => {
  try { parseXml(xml); check(`accepts ${label}`, true); }
  catch (e) { check(`accepts ${label}`, false, e.message); }
};
accepts("a single hyphen in a comment", good.replace("Windows 10 / 11", "Windows 10 - 11"));
accepts("a CDATA section", good.replace("<windowsSettings>", "<windowsSettings><![CDATA[ -- ]]>"). replace("</windowsSettings>", "</windowsSettings>"));
accepts("an escaped ampersand in text", good.replace("permonitorv2<", "permonitor&amp;v2<"));
accepts("an ampersand inside a comment, where XML allows it", good.replace("Windows 10 / 11", "Windows 10 & 11"));
accepts("single-quoted attribute values", good.replace('level="asInvoker"', "level='asInvoker'"));

/* --- 4. the build refuses to ship an invalid one ----------------------------- */
console.log("\n[4] The build gates on it");

const build = readFileSync(`${REPO}/scripts/build-windows.sh`, "utf8");
check("build-windows.sh validates the source manifest before publishing",
  /validate-manifest\.mjs" "\$manifest" --quiet/.test(build));
check("…and the manifest embedded in the .exe it just produced, before copying it out",
  build.indexOf("--exe \"$publish_dir/Applet.exe\"") > build.indexOf("dotnet publish") &&
  build.indexOf("--exe \"$publish_dir/Applet.exe\"") < build.indexOf('cp "$publish_dir/Applet.exe"'));
check("set -e is on, so a failing validation aborts the build", /^set -euo pipefail$/m.test(build));

// Prove it, rather than asserting it from the source: run the real CLI against a
// corrupted manifest and require a non-zero exit.
let exit = 0;
try {
  execFileSync("node", [`${REPO}/scripts/validate-manifest.mjs`, "/dev/stdin", "--quiet"],
    { input: good.replace("install-service switch", "--install-service switch"), stdio: ["pipe", "pipe", "pipe"] });
} catch (e) { exit = e.status; }
check("the validator CLI exits non-zero on an invalid manifest", exit === 1, `exit ${exit}`);

let okExit = 0;
try { execFileSync("node", [`${REPO}/scripts/validate-manifest.mjs`, SOURCE, "--quiet"]); }
catch (e) { okExit = e.status; }
check("…and zero on the real one", okExit === 0, `exit ${okExit}`);

report("windows application manifest");
