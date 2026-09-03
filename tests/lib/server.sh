#!/usr/bin/env bash
# Dev-server lifecycle for the regression suite. Sourced, not executed.
#
# Every block that depends on server state — the per-IP join rate limiter, the
# code TTL, the audit log — gets a *fresh* server, so one block's leftovers can
# never decide another block's result.

HDA_TEST_PORT="${HDA_TEST_PORT:-8099}"
AUDIT_DIR="${AUDIT_DIR:-/tmp/hda-test-audit}"
SERVER_LOG="${SERVER_LOG:-/tmp/hda-test-server.log}"
SERVER_PID_FILE="${SERVER_PID_FILE:-/tmp/hda-test-server.pid}"
export HDA_TEST_PORT AUDIT_DIR SERVER_LOG
export BASE="http://127.0.0.1:${HDA_TEST_PORT}"
export WS_URL="ws://127.0.0.1:${HDA_TEST_PORT}/ws"

server_stop() {
  if [[ -f "$SERVER_PID_FILE" ]]; then
    kill "$(cat "$SERVER_PID_FILE")" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$(cat "$SERVER_PID_FILE")" 2>/dev/null || break
      sleep 0.1
    done
    rm -f "$SERVER_PID_FILE"
  fi
}

# server_start [KEY=VALUE ...] — extra environment for this run only.
server_start() {
  server_stop
  env AUDIT_DIR="$AUDIT_DIR" PORT="$HDA_TEST_PORT" \
      PUBLIC_HOST="127.0.0.1:${HDA_TEST_PORT}" \
      CONSOLE_PASSWORD="${CONSOLE_PASSWORD:-}" \
      "$@" node "$REPO/server/dist/index.js" >> "$SERVER_LOG" 2>&1 &
  echo $! > "$SERVER_PID_FILE"
  for _ in $(seq 1 40); do
    if curl -sf "http://127.0.0.1:${HDA_TEST_PORT}/healthz" >/dev/null; then return 0; fi
    sleep 0.15
  done
  echo "server failed to start on port ${HDA_TEST_PORT} — see $SERVER_LOG" >&2
  tail -20 "$SERVER_LOG" >&2
  return 1
}

server_reset_state() {
  rm -rf "$AUDIT_DIR"; mkdir -p "$AUDIT_DIR"
  : > "$SERVER_LOG"
}
