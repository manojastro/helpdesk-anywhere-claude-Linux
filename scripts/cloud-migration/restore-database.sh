#!/usr/bin/env bash
# Load a PostgreSQL dump made by backup-current-vm.sh into this VM's database.
#
#   ./scripts/cloud-migration/restore-database.sh <dump-file> live
#   ./scripts/cloud-migration/restore-database.sh <dump-file> staging
#
# live    — the deployment's `db` service (docker-compose.yml, .env)
# staging — the isolated staging stack (project hda-staging, .env.staging),
#           exactly as scripts/staging.sh addresses it
#
# Starts ONLY the db service, waits for it, then pg_restore's the dump. Run it
# BEFORE the app first starts, so the app's migrations run on top of the
# restored schema instead of creating an empty one first.
#
# Never destroys data: if the target database already has tables it refuses
# and changes nothing. To really replace it, remove that volume yourself first.
#
# Env overrides (used by the test that exercises this against a throwaway
# project; not needed in normal use):
#   HDA_DB_PROJECT   compose project name for the staging target
set -euo pipefail

[[ $# -eq 2 ]] || { sed -n '2,20p' "$0" >&2; exit 2; }
dump="$1"
target="$2"
[[ -f "$dump" ]] || { echo "error: dump not found: $dump" >&2; exit 1; }
dump="$(cd "$(dirname "$dump")" && pwd)/$(basename "$dump")"

repo_root="$(pwd)"
cd "$repo_root"
[[ -f docker-compose.yml ]] || { echo "error: run from the repo root" >&2; exit 1; }

case "$target" in
  live)
    [[ -f .env ]] || { echo "error: .env is missing — restore it first" >&2; exit 1; }
    compose=(docker compose)
    ;;
  staging)
    [[ -f .env.staging ]] || { echo "error: .env.staging is missing — restore it first" >&2; exit 1; }
    compose=(docker compose -p "${HDA_DB_PROJECT:-hda-staging}" --env-file .env.staging
             -f docker-compose.yml -f docker-compose.staging.yml)
    ;;
  *) echo "error: target must be 'live' or 'staging'" >&2; exit 2 ;;
esac

if ! "${compose[@]}" config --services 2>/dev/null | grep -qx db; then
  echo "error: this checkout's compose file has no 'db' service." >&2
  echo "       The dump needs the admin-portal code (feature/admin-portal or later)." >&2
  exit 1
fi

export HOST_UID="${HOST_UID:-$(id -u)}" HOST_GID="${HOST_GID:-$(id -g)}"
echo "→ starting only the db service ($target)"
"${compose[@]}" up -d db

# Check over TCP, not the socket: on a fresh volume the image first runs a
# temporary socket-only server for initdb, then restarts. A socket check passes
# against that temporary server and the restore then lands in the restart gap.
ready=0
for _ in $(seq 1 90); do
  if "${compose[@]}" exec -T db pg_isready -h 127.0.0.1 -U helpdesk -d helpdesk >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
[[ "$ready" -eq 1 ]] || { echo "error: database did not become ready" >&2; exit 1; }

existing="$("${compose[@]}" exec -T db psql -U helpdesk -d helpdesk -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")"
if [[ "${existing//[[:space:]]/}" != "0" ]]; then
  echo "→ $target database already has ${existing//[[:space:]]/} table(s) — NOT restoring over it."
  echo "  Nothing was changed. If you really want the dump instead, remove the"
  echo "  database volume yourself and re-run this script."
  exit 0
fi

echo "→ restoring $(basename "$dump") into the $target database"
"${compose[@]}" exec -T db pg_restore -U helpdesk -d helpdesk --no-owner --exit-on-error < "$dump"

tables="$("${compose[@]}" exec -T db psql -U helpdesk -d helpdesk -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")"
echo "→ restored: ${tables//[[:space:]]/} table(s) now in the $target database"
