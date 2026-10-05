/**
 * Approved, reviewed changes to files under windows/ made AFTER the golden
 * checkpoint (CLAUDE.md "CRITICAL REGRESSION WARNING").
 *
 * The golden-diff guards (source/25, source/27) stay strict: a changed Windows
 * file passes only if it appears here AND both its starting blob and its
 * current blob match exactly. Any further edit to an approved file changes its
 * blob hash and turns the guards red again, so each new change needs its own
 * reviewed entry. Every entry must name the reason and the regression test that
 * locks in the new behaviour.
 */
import { execFileSync } from "node:child_process";

export const APPROVED_WINDOWS_DELTAS = [
  {
    path: "windows/SecureDesktopService/ServiceLink.cs",
    // Blob at the golden tag (also unchanged at 22ce263, the multi-session base).
    from: "be17b1b1e2ca7b6715ff00ca9fd4dd6ce66daca8",
    to: "1188b0c41f1a0ce24d0405dd8832ffa99c8ee54e",
    reason:
      "Security audit 2026-10-05 F-01: SYSTEM scripts were staged in %TEMP% of LocalSystem " +
      "(C:\\Windows\\Temp on Windows 10), a directory any user can pre-create and own. Staging " +
      "moved into the service's own protected directory; interpreters use absolute paths. " +
      "Script staging only — no pipe, desktop, input or elevation logic changed.",
    test: "tests/source/28-audit-invariants.mjs",
  },
];

/** Blob id of `path` at `rev`, or null when it does not exist there. */
function blobAt(repo, rev, path) {
  try {
    return execFileSync("git", ["-C", repo, "rev-parse", `${rev}:${path}`], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Blob id of the working-tree file. */
function blobNow(repo, path) {
  try {
    return execFileSync("git", ["-C", repo, "hash-object", path], { encoding: "utf8", cwd: repo }).trim();
  } catch {
    return null;
  }
}

/** True when `path` differs from `base` only by an approved, hash-pinned delta. */
export function isApprovedDelta(repo, base, path) {
  const entry = APPROVED_WINDOWS_DELTAS.find((d) => d.path === path);
  if (!entry) return false;
  return blobAt(repo, base, path) === entry.from && blobNow(repo, path) === entry.to;
}
