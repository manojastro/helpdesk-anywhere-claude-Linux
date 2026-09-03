#!/usr/bin/env bash
# Run the server locally with hot reload. Loads .env if present.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Export the keys the server reads, WITHOUT sourcing .env. A .env is data, not a
# shell script: `source` executes it, so `AGENT_NAME=Support Agent` runs `Agent`
# as a command and a value containing a backtick runs whatever is inside it.
if [[ -f "$repo_root/.env" ]]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    value="${value#"${value%%[![:space:]]*}"}"          # ltrim
    value="${value%\"}"; value="${value#\"}"            # strip one layer of quotes
    value="${value%\'}"; value="${value#\'}"
    export "$key=$value"
  done < "$repo_root/.env"
fi

cd "$repo_root/server"
[[ -d node_modules ]] || npm ci
exec npm run dev
