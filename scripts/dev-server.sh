#!/usr/bin/env bash
# Run the server locally with hot reload. Loads .env if present.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$repo_root/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$repo_root/.env"
  set +a
fi

cd "$repo_root/server"
[[ -d node_modules ]] || npm ci
exec npm run dev
