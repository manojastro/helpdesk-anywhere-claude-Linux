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

# Shared .env handling: read_env, harden_env, looks_placeholder (scripts/lib/envfile.sh).
source "$repo_root/scripts/lib/envfile.sh"
harden_env

PUBLIC_HOST="$(read_env PUBLIC_HOST)"

if [[ -z "$PUBLIC_HOST" ]]; then
  echo "error: PUBLIC_HOST is not set in .env" >&2
  exit 1
fi

# The same refusal deploy-ngrok.sh makes, and it matters more here: this path
# puts the console on a permanent hostname with a real certificate. An open
# console on a public URL is a working remote-control panel for whoever finds it
# (CLAUDE.md 7.5). It was missing from this script entirely.
if looks_placeholder "$(read_env CONSOLE_PASSWORD)" && [[ "${1:-}" != "--allow-open-console" ]]; then
  cat >&2 <<'MSG'
error: CONSOLE_PASSWORD is unset or still a placeholder, and this deployment
       will be reachable from the public internet.

  The agent console has no login of its own (PLAN.md puts that out of scope), so
  this shared password is the only thing between the hostname and a working
  remote-control console.

  Set CONSOLE_PASSWORD in .env, or pass --allow-open-console if you genuinely
  want it open.
MSG
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
