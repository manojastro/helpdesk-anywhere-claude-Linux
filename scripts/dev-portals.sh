#!/usr/bin/env bash
# Run BOTH applications locally, with no Entra tenant and no DNS:
#
#   technician console  http://localhost:8080
#   admin portal        http://localhost:8081
#
#   ./scripts/dev-portals.sh          start (foreground; Ctrl+C stops the server)
#   ./scripts/dev-portals.sh reset    also wipe the local database first
#   ./scripts/dev-portals.sh stop-db  stop and remove the local PostgreSQL container
#
# Sign-in uses the DEVELOPMENT form (AUTH_MODE=dev): pick any object ID, name and
# app roles. The first admin is the object ID below. The server refuses this
# mode under NODE_ENV=production or on any non-loopback hostname, so this cannot
# be turned into a deployment by accident.
#
# PostgreSQL runs in a throwaway container `hda-dev-pg` on 127.0.0.1:55433.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_CONTAINER="${PG_CONTAINER:-hda-dev-pg}"
PG_PORT="${PG_PORT:-55433}"
DEV_ADMIN_OID="${DEV_ADMIN_OID:-aaaaaaaa-0000-4000-8000-000000000001}"

if [[ "${1:-}" == "stop-db" ]]; then
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  echo "removed $PG_CONTAINER"
  exit 0
fi

if [[ "${1:-}" == "reset" ]]; then
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
  if docker ps -a --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    docker start "$PG_CONTAINER" >/dev/null
  else
    docker run -d --name "$PG_CONTAINER" -e POSTGRES_PASSWORD=devonly \
      -p "127.0.0.1:${PG_PORT}:5432" postgres:16-alpine >/dev/null
  fi
  echo "→ waiting for PostgreSQL…"
  for _ in $(seq 1 60); do
    docker exec "$PG_CONTAINER" pg_isready -q && break
    sleep 0.5
  done
fi

cd "$repo_root/server"
[[ -d node_modules ]] || npm ci
npm run build >/dev/null
mkdir -p "$repo_root/.dev-audit"   # never ./audit: the deployed container writes there

cat <<MSG

  Technician console : http://localhost:8080
  Admin portal       : http://localhost:8081
  First admin        : sign in to the admin portal with object ID
                       $DEV_ADMIN_OID and the Admin role.
  Customer join page : http://localhost:8080/j/<code>

MSG

exec env NODE_ENV=development AUTH_MODE=dev \
  DATABASE_URL="postgres://postgres:devonly@127.0.0.1:${PG_PORT}/postgres" \
  PORT=8080 ADMIN_PORT=8081 PUBLIC_HOST=localhost:8080 ADMIN_PUBLIC_HOST=localhost:8081 \
  AUDIT_DIR="$repo_root/.dev-audit" BOOTSTRAP_ADMIN_OIDS="$DEV_ADMIN_OID" ALLOW_INSECURE_DEV=0 \
  node dist/index.js
