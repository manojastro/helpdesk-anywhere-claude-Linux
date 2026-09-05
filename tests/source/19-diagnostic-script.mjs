/**
 * scripts/mt06-diagnostics.ps1 must actually parse on the Windows test machine.
 *
 * WHY THIS EXISTS — 2026-09-05. The MT-06 diagnostic script downloaded fine and
 * then would not run: Windows PowerShell reported five parse errors and "The
 * string is missing the terminator", and the output contained mojibake (`a<euro>"`).
 *
 * The script's syntax was correct. The ENCODING was the bug, and it is a trap
 * worth stating precisely:
 *
 *   Windows PowerShell 5.1 decodes a .ps1 with no byte-order mark using the
 *   system ANSI code page, not UTF-8. On a CP1252 machine a UTF-8 em dash
 *   (E2 80 94) is read as three characters - U+00E2, U+20AC, U+201D - and that
 *   last one is a smart double quote, which PowerShell's tokenizer accepts as a
 *   STRING DELIMITER. Each decorative dash opens an unterminated string, and the
 *   parse collapses lines later with bracket errors pointing nowhere near it.
 *
 * THE PART THAT MATTERS FOR TESTING: parsing the broken file as UTF-8 reported
 * ZERO errors. A `pwsh` parse on Linux would have declared it healthy, because
 * pwsh reads UTF-8 by default. Modelling the decode is the whole check - so this
 * block parses the file the way 5.1 would see it, and enforces the two
 * properties that make the decode moot in the first place.
 *
 * The two properties, either of which alone would have prevented this:
 *   1. the body is pure ASCII, so every code page agrees on it;
 *   2. the file carries a UTF-8 BOM, so 5.1 decodes it as UTF-8 regardless.
 *
 * Both, because a BOM can be stripped in transit and a future edit can paste in
 * a smart quote.
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, report, REPO } from "../lib/harness.mjs";

const SCRIPT = `${REPO}/scripts/mt06-diagnostics.ps1`;

console.log("\n=== MT-06 diagnostic script: parses under Windows PowerShell 5.1 ===\n");

const raw = readFileSync(SCRIPT);

/* --- 1. the encoding rules ------------------------------------------------- */
console.log("[1] Encoding");

const hasBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
check("the file carries a UTF-8 BOM, so PowerShell 5.1 decodes it as UTF-8",
  hasBom, hasBom ? "" : "no BOM: 5.1 will decode this with the system ANSI code page");

const body = hasBom ? raw.subarray(3) : raw;
const nonAscii = [...body].filter((b) => b > 0x7f);
check("the body is pure ASCII, so every code page decodes it identically",
  nonAscii.length === 0,
  nonAscii.length === 0 ? "" : `${nonAscii.length} non-ASCII bytes`);

// Name the specific characters that cause this failure, so a future edit that
// pastes one in fails with an explanation rather than a byte count.
const text = body.toString("utf8");
const traps = {
  "em dash U+2014": "—",
  "en dash U+2013": "–",
  "left smart double quote U+201C": "“",
  "right smart double quote U+201D": "”",
  "left smart single quote U+2018": "‘",
  "right smart single quote U+2019": "’",
  "ellipsis U+2026": "…",
  "non-breaking space U+00A0": " ",
};
for (const [name, ch] of Object.entries(traps)) {
  check(`no ${name}`, !text.includes(ch));
}

check("no CRLF/LF mixing that would confuse a here-string",
  !/\r/.test(text) || !/[^\r]\n/.test(text));

/* --- 2. balanced delimiters ------------------------------------------------ */
console.log("\n[2] Balanced delimiters");

// Counted outside strings and comments, which is the only way the count means
// anything: this script is mostly Write-Host lines full of brackets.
function scan(src) {
  const depth = { "(": 0, "{": 0, "[": 0 };
  const close = { ")": "(", "}": "{", "]": "[" };
  let i = 0, single = 0, double = 0, unbalancedClose = null;

  while (i < src.length) {
    const c = src[i];

    if (c === "#" && src.slice(i, i + 2) !== "#>") {          // line comment
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (src.slice(i, i + 2) === "<#") {                        // block comment
      const end = src.indexOf("#>", i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === "'") {                                           // single-quoted
      single++;
      i++;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") { i += 2; continue; }
        if (src[i] === "'") { single++; i++; break; }
        i++;
      }
      continue;
    }
    if (c === '"') {                                           // double-quoted
      double++;
      i++;
      while (i < src.length) {
        if (src[i] === "`") { i += 2; continue; }
        if (src[i] === '"' && src[i + 1] === '"') { i += 2; continue; }
        if (src[i] === '"') { double++; i++; break; }
        i++;
      }
      continue;
    }
    if (c in depth) depth[c]++;
    else if (c in close) {
      depth[close[c]]--;
      if (depth[close[c]] < 0 && !unbalancedClose) unbalancedClose = `${c} at offset ${i}`;
    }
    i++;
  }
  return { depth, single, double, unbalancedClose };
}

const s = scan(text);
check("parentheses balanced outside strings and comments", s.depth["("] === 0, `net ${s.depth["("]}`);
check("braces balanced outside strings and comments", s.depth["{"] === 0, `net ${s.depth["{"]}`);
check("square brackets balanced outside strings and comments", s.depth["["] === 0, `net ${s.depth["["]}`);
check("no closing delimiter without an opener", s.unbalancedClose === null, s.unbalancedClose ?? "");
check("single quotes pair up", s.single % 2 === 0, `${s.single} seen`);
check("double quotes pair up", s.double % 2 === 0, `${s.double} seen`);

/* --- 3. nothing that needs PowerShell 7 ------------------------------------ */
console.log("\n[3] Windows PowerShell 5.1 compatibility");

// Stripped of strings and comments first: "[ ?? ]" appears inside a Write-Host
// literal and is not the null-coalescing operator.
const codeOnly = text
  .replace(/<#[\s\S]*?#>/g, " ")
  .replace(/'(?:''|[^'])*'/g, "''")
  .replace(/"(?:`.|""|[^"])*"/g, '""')
  .replace(/^\s*#.*$/gm, " ");

for (const [name, re] of [
  ["null-coalescing ?? (7.0+)", /\?\?/],
  ["null-conditional ?. (7.0+)", /\?\./],
  ["pipeline chain && or || (7.0+)", /&&|\|\|/],
  ["ternary ? : (7.0+)", /\)\s*\?[^?]*:/],
  ["$PSStyle (7.2+)", /\$PSStyle/],
  ["ForEach-Object -Parallel (7.0+)", /-Parallel\b/],
  ["Get-Error (7.0+)", /\bGet-Error\b/],
]) {
  check(`no ${name}`, !re.test(codeOnly));
}

check("uses Get-CimInstance, not the WMI cmdlets removed in 7",
  /Get-CimInstance/.test(codeOnly) && !/Get-WmiObject/.test(codeOnly));

/* --- 4. it observes; it does not change the machine ------------------------ */
console.log("\n[4] The diagnostic only observes (it runs elevated on a test machine)");

for (const [what, re] of [
  ["change UAC policy", /EnableLUA|ConsentPromptBehavior|PromptOnSecureDesktop|Set-ItemProperty.*System\\\\CurrentControlSet/i],
  ["touch Defender", /Set-MpPreference|Add-MpPreference|DisableRealtimeMonitoring/i],
  ["self-elevate", /Start-Process.*-Verb\s+RunAs/i],
  ["start, stop or reconfigure the service", /\b(Start-Service|Stop-Service|Set-Service|sc\.exe|New-Service|Remove-Service)\b/i],
  ["kill processes", /\bStop-Process\b/i],
  ["write to the registry", /\b(Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|reg\.exe|reg add)\b/i],
  ["change execution policy", /Set-ExecutionPolicy/i],
  ["reach the network", /Invoke-WebRequest|Invoke-RestMethod|Net\.WebClient|curl\.exe|wget/i],
  ["read or log a credential", /Get-Credential|ConvertTo-SecureString|-AsPlainText|\$password|\$cred\b/i],
  ["log keystrokes", /GetAsyncKeyState|SetWindowsHookEx|keybd_event/i],
]) {
  check(`does not ${what}`, !re.test(codeOnly));
}

// It does delete files - only its own logs, only with -Clear, and only by the
// hda-*.log pattern. Assert that shape rather than banning deletion outright.
const removals = [...text.matchAll(/Remove-Item[^\n]*/g)].map((m) => m[0]);
check("the only deletion is its own hda-*.log files, behind -Clear",
  removals.length > 0 && removals.every((r) => r.includes("hda-*.log")),
  removals.join(" | ") || "none");

/* --- 5. the real PowerShell parser ----------------------------------------- */
console.log("\n[5] PowerShell parser");

const PWSH = [`${process.env.HOME}/.local/pwsh/pwsh`, "/usr/bin/pwsh", "/snap/bin/pwsh"]
  .find((p) => existsSync(p));

if (!PWSH) {
  console.log("  (o) pwsh not installed - the checks above still ran, and they are the");
  console.log("      ones that catch this class of bug: a UTF-8 parse of the BROKEN file");
  console.log("      reported zero errors. Install PowerShell to enable this block.");
} else {
  const dir = mkdtempSync(join(tmpdir(), "hda-ps-"));
  const harness = join(dir, "parse.ps1");
  writeFileSync(harness, `param([string]$Path)
$tokens = $null; $errors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Path), [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -eq 0) { Write-Output "OK" }
else { $errors | ForEach-Object { Write-Output ("line {0}: {1}" -f $_.Extent.StartLineNumber, $_.Message) } }
`);

  const parse = (file) => {
    try {
      return execFileSync(PWSH, ["-NoProfile", "-File", harness, "-Path", file],
        { encoding: "utf8", timeout: 120000 }).trim();
    } catch (e) {
      return `harness failed: ${(e.stdout || e.message || "").toString().slice(0, 300)}`;
    }
  };

  const asUtf8 = join(dir, "utf8.ps1");
  writeFileSync(asUtf8, text, "utf8");
  const utf8Result = parse(asUtf8);
  check("parses cleanly when decoded as UTF-8", utf8Result === "OK", utf8Result.slice(0, 300));

  // The check that would have caught the bug: reinterpret the raw bytes the way
  // Windows PowerShell 5.1 does when there is no BOM, and parse THAT.
  const asAnsi = join(dir, "ansi.ps1");
  writeFileSync(asAnsi, Buffer.from(body).toString("latin1"), "utf8");
  const ansiResult = parse(asAnsi);
  check("…and still parses if the BOM is lost and it is decoded as a single-byte code page",
    ansiResult === "OK", ansiResult.slice(0, 300));
}

report("MT-06 diagnostic script");
