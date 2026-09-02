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

dotnet publish "$repo_root/windows/Applet/Applet.csproj" \
  -c Release -r win-x64 --self-contained true \
  -p:PublishSingleFile=true -p:EnableWindowsTargeting=true \
  -o "$publish_dir"

dest="$repo_root/server/public/download/HelpdeskAnywhere.exe"
cp "$publish_dir/Applet.exe" "$dest"

printf '→ %s (%s)\n' "$dest" "$(du -h "$dest" | cut -f1)"
