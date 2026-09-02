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

if [[ ! -f .env ]]; then
  echo "error: .env not found. Copy .env.example to .env and set PUBLIC_HOST." >&2
  exit 1
fi

# shellcheck disable=SC1091
source .env

if [[ -z "${PUBLIC_HOST:-}" ]]; then
  echo "error: PUBLIC_HOST is not set in .env" >&2
  exit 1
fi

resolved="$(dig +short "$PUBLIC_HOST" | tail -1)"
if [[ -z "$resolved" ]]; then
  echo "error: $PUBLIC_HOST does not resolve. Complete PLAN 7.2 first." >&2
  exit 1
fi
echo "→ $PUBLIC_HOST resolves to $resolved"

docker compose build
docker compose up -d
docker compose ps
