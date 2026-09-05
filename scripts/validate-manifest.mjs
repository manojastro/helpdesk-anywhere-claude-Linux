#!/usr/bin/env node
/**
 * Validate the Windows application manifest — the source XML, the RT_MANIFEST
 * resource inside a built .exe, or both, asserting they are the same bytes.
 *
 *   node scripts/validate-manifest.mjs windows/Applet/app.manifest
 *   node scripts/validate-manifest.mjs some/Applet.exe
 *   node scripts/validate-manifest.mjs windows/Applet/app.manifest --exe some/Applet.exe
 *
 * Exits non-zero on the first failure, so scripts/build-windows.sh can gate the
 * publish on it. See tests/lib/manifest.mjs for why this exists (MT-01).
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  validateManifest, readPeManifest, IMAGE_FILE_MACHINE_AMD64,
} from "../tests/lib/manifest.mjs";

const args = process.argv.slice(2);
let sourcePath = null;
let exePath = null;
let quiet = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--exe") exePath = args[++i];
  else if (args[i] === "--quiet" || args[i] === "-q") quiet = true;
  else if (args[i] === "-h" || args[i] === "--help") {
    console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(2, 11).join("\n"));
    process.exit(0);
  } else if (/\.exe$/i.test(args[i])) exePath = args[i];
  else sourcePath = args[i];
}

if (!sourcePath && !exePath) {
  console.error("usage: validate-manifest.mjs <app.manifest> [--exe <file.exe>]");
  process.exit(2);
}

let failures = 0;
const emit = (results) => {
  for (const r of results) {
    if (!r.ok) failures++;
    if (!r.ok || !quiet) {
      console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);
    }
  }
};

let sourceBytes = null;
if (sourcePath) {
  sourceBytes = readFileSync(sourcePath);
  if (!quiet) console.log(`\nsource manifest — ${sourcePath}`);
  emit(validateManifest(sourceBytes, { where: "source" }));
}

if (exePath) {
  if (!quiet) console.log(`\nembedded manifest — ${exePath}`);
  const { machine, manifests } = readPeManifest(exePath);
  const results = [];
  results.push({
    name: `${basename(exePath)} is a PE for x64 (machine 0x8664)`,
    ok: machine === IMAGE_FILE_MACHINE_AMD64,
    detail: `0x${machine.toString(16)}`,
  });
  results.push({
    name: "exactly one RT_MANIFEST resource is embedded",
    ok: manifests.length === 1,
    detail: `${manifests.length} found`,
  });
  emit(results);

  if (manifests.length === 1) {
    const embedded = manifests[0].bytes;
    emit(validateManifest(embedded, { where: "embedded" }));
    if (sourceBytes) {
      emit([{
        name: "the embedded manifest is byte-identical to the source (no build step altered it)",
        ok: Buffer.compare(embedded, sourceBytes) === 0,
        detail: `${embedded.length} vs ${sourceBytes.length} bytes`,
      }]);
    }
  }
}

if (failures) {
  console.error(`\nmanifest validation FAILED — ${failures} check${failures === 1 ? "" : "s"}.`);
  console.error("A malformed manifest cross-compiles fine and then refuses to start on Windows");
  console.error('with "the application has failed to start because its side-by-side configuration');
  console.error('is incorrect". Fix it here; Windows will not give you a better message.');
  process.exit(1);
}
if (!quiet) console.log("\nmanifest OK.");
