#!/usr/bin/env bash
# Cross-compile the Windows applet from Ubuntu and drop the .exe straight into
# server/public/download/, so the dev loop and the product flow are the same path
# (CLAUDE.md, PLAN 2.1).
#
# EnableWindowsTargeting=true is REQUIRED to build a WinForms/Windows-targeted
# project from Linux; without it the SDK refuses.
#
# This produces a binary. It does NOT test it — Windows code cannot be run-tested
# on Ubuntu (CLAUDE.md "Hard environment boundary"). Re-download it on the Windows
# test machine from the join page and run it there.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
publish_dir="$(mktemp -d)"
trap 'rm -rf "$publish_dir"' EXIT

# PLAN 2.2: the server URL is baked into the .exe so the end user types nothing
# but the six digits. SERVER_URL wins; otherwise it is derived from PUBLIC_HOST
# (env, else the local .env used by docker-compose). Always wss: — see CLAUDE.md
# "Public URL and TLS"; the code-entry form can still override it for dev.
if [[ -z "${SERVER_URL:-}" ]]; then
  if [[ -z "${PUBLIC_HOST:-}" && -f "$repo_root/.env" ]]; then
    PUBLIC_HOST="$(sed -n 's/^[[:space:]]*PUBLIC_HOST[[:space:]]*=[[:space:]]*//p' "$repo_root/.env" | tail -n1)"
  fi
  if [[ -n "${PUBLIC_HOST:-}" ]]; then
    SERVER_URL="wss://${PUBLIC_HOST}/ws"
  fi
fi

server_url_arg=()
if [[ -n "${SERVER_URL:-}" ]]; then
  server_url_arg=("-p:ServerUrl=${SERVER_URL}")
  printf 'baking server URL: %s\n' "$SERVER_URL"
else
  printf 'no SERVER_URL/PUBLIC_HOST set — the .exe keeps its built-in default\n'
fi

dotnet publish "$repo_root/windows/Applet/Applet.csproj" \
  -c Release -r win-x64 --self-contained true \
  -p:PublishSingleFile=true -p:EnableWindowsTargeting=true \
  "${server_url_arg[@]}" \
  -o "$publish_dir"

dest="$repo_root/server/public/download/HelpdeskAnywhere.exe"
cp "$publish_dir/Applet.exe" "$dest"

printf '→ %s (%s)\n' "$dest" "$(du -h "$dest" | cut -f1)"
