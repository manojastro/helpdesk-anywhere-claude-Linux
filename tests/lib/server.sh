#!/usr/bin/env bash
# Dev-server lifecycle for the regression suite. Sourced, not executed.
#
# Every block that depends on server state — the per-IP join rate limiter, the
# code TTL, the audit log, the database — gets a *fresh* server, so one block's
# leftovers can never decide another block's result.
#
# Since the admin-portal release the server needs PostgreSQL and a signed-in
# technician. The suite runs it with AUTH_MODE=dev on loopback (the only place
# dev sign-in is allowed) against a throwaway database, and provisions two
# identities after every start (tests/lib/provision.mjs):
#   HDA_ADMIN_COOKIE  an active Admin on the admin portal
#   HDA_AGENT_COOKIE  an active Agent on the technician console

HDA_TEST_PORT="${HDA_TEST_PORT:-8099}"
HDA_TEST_ADMIN_PORT="${HDA_TEST_ADMIN_PORT:-8098}"
AUDIT_DIR="${AUDIT_DIR:-/tmp/hda-test-audit}"
SERVER_LOG="${SERVER_LOG:-/tmp/hda-test-server.log}"
SERVER_PID_FILE="${SERVER_PID_FILE:-/tmp/hda-test-server.pid}"
HDA_TEST_PG_CONTAINER="${HDA_TEST_PG_CONTAINER:-hda-test-pg}"
HDA_TEST_PG_PORT="${HDA_TEST_PG_PORT:-55432}"
HDA_TEST_DB="${HDA_TEST_DB:-hda_test}"
HDA_TEST_PG_ADMIN_URL="${HDA_TEST_PG_ADMIN_URL:-postgres://postgres:hdatest@127.0.0.1:${HDA_TEST_PG_PORT}/postgres}"
HDA_TEST_DATABASE_URL="${HDA_TEST_DATABASE_URL:-postgres://postgres:hdatest@127.0.0.1:${HDA_TEST_PG_PORT}/${HDA_TEST_DB}}"
export HDA_TEST_PORT HDA_TEST_ADMIN_PORT AUDIT_DIR SERVER_LOG HDA_TEST_DATABASE_URL HDA_TEST_PG_ADMIN_URL HDA_TEST_DB
export BASE="http://127.0.0.1:${HDA_TEST_PORT}"
export ADMIN_BASE="http://127.0.0.1:${HDA_TEST_ADMIN_PORT}"
export WS_URL="ws://127.0.0.1:${HDA_TEST_PORT}/ws"
# The Entra object ID the suite's first admin uses; the server only bootstraps it.
export HDA_TEST_BOOTSTRAP_OID="aaaaaaaa-0000-4000-8000-00000000ad01"

# Start (or reuse) a throwaway PostgreSQL in Docker, unless the caller supplied
# HDA_TEST_PG_ADMIN_URL / HDA_TEST_DATABASE_URL for one of their own.
db_ensure() {
  if node "$REPO/tests/lib/db.mjs" ping >/dev/null 2>&1; then return 0; fi
  if ! command -v docker >/dev/null; then
    echo "PostgreSQL is not reachable at $HDA_TEST_PG_ADMIN_URL and docker is unavailable." >&2
    return 1
  fi
  if ! docker ps -a --format '{{.Names}}' | grep -qx "$HDA_TEST_PG_CONTAINER"; then
    docker run -d --name "$HDA_TEST_PG_CONTAINER" -e POSTGRES_PASSWORD=hdatest \
      -p "127.0.0.1:${HDA_TEST_PG_PORT}:5432" postgres:16-alpine >/dev/null || return 1
  else
    docker start "$HDA_TEST_PG_CONTAINER" >/dev/null || return 1
  fi
  for _ in $(seq 1 60); do
    node "$REPO/tests/lib/db.mjs" ping >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "test PostgreSQL did not become ready" >&2
  return 1
}

db_reset() {
  node "$REPO/tests/lib/db.mjs" reset >/dev/null
}

server_stop() {
  if [[ -f "$SERVER_PID_FILE" ]]; then
    kill "$(cat "$SERVER_PID_FILE")" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$(cat "$SERVER_PID_FILE")" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$(cat "$SERVER_PID_FILE")" 2>/dev/null || true
    rm -f "$SERVER_PID_FILE"
  fi
}

# Simulate a crash: no graceful shutdown, so nothing gets to close its records.
server_crash() {
  if [[ -f "$SERVER_PID_FILE" ]]; then
    kill -9 "$(cat "$SERVER_PID_FILE")" 2>/dev/null || true
    sleep 0.3
    rm -f "$SERVER_PID_FILE"
  fi
}

# server_start [KEY=VALUE ...] — extra environment for this run only.
server_start() {
  server_stop
  env AUDIT_DIR="$AUDIT_DIR" PORT="$HDA_TEST_PORT" ADMIN_PORT="$HDA_TEST_ADMIN_PORT" \
      PUBLIC_HOST="127.0.0.1:${HDA_TEST_PORT}" ADMIN_PUBLIC_HOST="127.0.0.1:${HDA_TEST_ADMIN_PORT}" \
      DATABASE_URL="$HDA_TEST_DATABASE_URL" AUTH_MODE=dev NODE_ENV=test \
      BOOTSTRAP_ADMIN_OIDS="$HDA_TEST_BOOTSTRAP_OID" SIGNIN_ATTEMPTS_PER_MINUTE=1000 \
      "$@" node "$REPO/server/dist/index.js" >> "$SERVER_LOG" 2>&1 &
  echo $! > "$SERVER_PID_FILE"
  local up=0
  for _ in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:${HDA_TEST_PORT}/healthz" >/dev/null \
       && curl -sf "http://127.0.0.1:${HDA_TEST_ADMIN_PORT}/healthz" >/dev/null; then up=1; break; fi
    sleep 0.15
  done
  if [[ $up -ne 1 ]]; then
    echo "server failed to start on ports ${HDA_TEST_PORT}/${HDA_TEST_ADMIN_PORT} — see $SERVER_LOG" >&2
    tail -20 "$SERVER_LOG" >&2
    return 1
  fi
  # Sign in the suite's admin and technician (idempotent across restarts).
  local cookies
  cookies="$(node "$REPO/tests/lib/provision.mjs")" || { echo "provisioning failed" >&2; return 1; }
  HDA_ADMIN_COOKIE="$(sed -n 1p <<<"$cookies")"
  HDA_AGENT_COOKIE="$(sed -n 2p <<<"$cookies")"
  export HDA_ADMIN_COOKIE HDA_AGENT_COOKIE
}

server_reset_state() {
  rm -rf "$AUDIT_DIR"; mkdir -p "$AUDIT_DIR"
  : > "$SERVER_LOG"
  db_ensure && db_reset
}
