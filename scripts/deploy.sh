#!/usr/bin/env bash
# Build and (re)start the stack (PLAN 7.1).
#
# Prerequisite: PUBLIC_HOST must already resolve publicly to this VM's IP
# (PLAN 7.2). Do NOT start Caddy before `dig +short $PUBLIC_HOST` returns the
# right address from OFF the VM — a failing ACME HTTP-01 challenge gets
# rate-limited by Let's Encrypt.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# The container must run as a uid that can write the bind-mounted ./audit
# directory, or the audit log fails silently (CLAUDE.md constraint #5).
export HOST_UID="${HOST_UID:-$(id -u)}"
export HOST_GID="${HOST_GID:-$(id -g)}"

if [[ ! -f .env ]]; then
  echo "error: .env not found. Copy .env.example to .env and set PUBLIC_HOST." >&2
  exit 1
fi

# Read PUBLIC_HOST without sourcing .env — a .env is data, not a shell script,
# and sourcing it executes any value containing a space or a backtick.
PUBLIC_HOST="$(sed -n 's/^[[:space:]]*PUBLIC_HOST[[:space:]]*=[[:space:]]*//p' .env \
  | tail -n1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")"

if [[ -z "$PUBLIC_HOST" ]]; then
  echo "error: PUBLIC_HOST is not set in .env" >&2
  exit 1
fi

resolved="$(dig +short "$PUBLIC_HOST" | tail -1)"
if [[ -z "$resolved" ]]; then
  echo "error: $PUBLIC_HOST does not resolve. Complete PLAN 7.2 first." >&2
  exit 1
fi
echo "→ $PUBLIC_HOST resolves to $resolved"

docker compose --profile tls build
docker compose --profile tls up -d
docker compose --profile tls ps

echo
echo "→ verifying the deployment"
"$repo_root/scripts/verify-deployment.sh" "https://$PUBLIC_HOST" 
