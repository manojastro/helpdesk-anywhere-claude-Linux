#!/usr/bin/env bash
# Validate the MT-06 diagnostic script, then publish it next to the applet.
#
#   ./scripts/publish-diagnostics.sh
#
# The download directory is served publicly and without credentials (the join
# page needs it that way), so what lands there is what a stranger can fetch.
# Two reasons this is a script rather than a `cp`:
#
#  1. It refuses to publish a script that will not parse on the Windows test
#     machine. On 2026-09-05 the diagnostic downloaded fine and then failed with
#     five parse errors, because Windows PowerShell 5.1 decodes a .ps1 with no
#     byte-order mark using the system ANSI code page — turning a UTF-8 em dash
#     into three characters, the last of which is a smart double quote that
#     PowerShell treats as a string delimiter. A whole test cycle for six dashes.
#
#  2. It re-checks that nothing secret is in the file. This is the one artefact
#     in this project that is published as readable text.
#
# tests/source/19-diagnostic-script.mjs is the validation; it models the 5.1
# decode, which a plain UTF-8 parse does not — the broken file parsed cleanly as
# UTF-8 and reported zero errors.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

src="scripts/mt06-diagnostics.ps1"
dest_dir="server/public/download"
dest="$dest_dir/mt06-diagnostics.ps1"

[[ -f "$src" ]] || { echo "error: $src not found" >&2; exit 1; }
[[ -d "$dest_dir" ]] || { echo "error: $dest_dir not found" >&2; exit 1; }

echo "→ validating $src"
node "$repo_root/tests/source/19-diagnostic-script.mjs" >/dev/null || {
  echo >&2
  echo "error: the diagnostic script did not validate. Not publishing." >&2
  echo "       Run it directly for the detail:" >&2
  echo "         node tests/source/19-diagnostic-script.mjs" >&2
  exit 1
}
echo "  validation passed"

# A belt-and-braces scan of the actual bytes about to be published. The test
# block covers the code paths; this covers the file as a whole, because the
# consequence of being wrong here is a secret on a public URL.
echo "→ scanning for anything that must not be published"
if grep -nEi 'BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|xox[baprs]-|AKIA[0-9A-Z]{16}|(authtoken|api[_-]?key|client[_-]?secret)[[:space:]]*[=:][[:space:]]*[A-Za-z0-9_\-]{12,}' "$src"; then
  echo "error: the diagnostic script looks like it contains a secret. Not publishing." >&2
  exit 1
fi
echo "  clean"

cp "$src" "$dest"

printf '\n→ %s\n' "$dest"
printf '  %s bytes\n' "$(stat -c '%s' "$dest")"
printf '  sha256 %s\n' "$(sha256sum "$dest" | cut -d' ' -f1)"

host="$(sed -n 's/^[[:space:]]*PUBLIC_HOST[[:space:]]*=[[:space:]]*//p' .env 2>/dev/null | tail -n1)"
if [[ -n "$host" ]]; then
  printf '\n  https://%s/download/mt06-diagnostics.ps1\n' "$host"
fi
