#!/usr/bin/env bash
# Verify a running deployment end to end at the HTTP/WS level (PLAN 7.1, 7.7).
#
# Works against any of the three topologies without changes, because all three
# serve the same routes:
#   ./scripts/verify-deployment.sh                              # local override
#   ./scripts/verify-deployment.sh https://xxxx.ngrok-free.app  # ngrok
#   ./scripts/verify-deployment.sh https://sub.duckdns.org      # DuckDNS + Caddy
#
# Credentials for the console check come from the environment (CONSOLE_USER /
# CONSOLE_PASSWORD, or .env) — never from an argument, which would put them in
# the shell history and the process list.
set -uo pipefail

base="${1:-http://127.0.0.1:8080}"
base="${base%/}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Shared .env handling (scripts/lib/envfile.sh). It reads ./.env, so run from
# anywhere: cd to the repo root first.
cd "$repo_root"
source "$repo_root/scripts/lib/envfile.sh"

CONSOLE_USER="${CONSOLE_USER:-$(read_env CONSOLE_USER)}"
CONSOLE_PASSWORD="${CONSOLE_PASSWORD:-$(read_env CONSOLE_PASSWORD)}"

pass=0; fail=0
check() {
  local name="$1" ok="$2" detail="${3:-}"
  if [[ "$ok" == "1" ]]; then
    pass=$((pass + 1)); printf '  PASS  %s%s\n' "$name" "${detail:+  — $detail}"
  else
    fail=$((fail + 1)); printf '  FAIL  %s%s\n' "$name" "${detail:+  — $detail}"
  fi
}
# No -f: a 401 is a result to assert on, not a failure to retry.
status() { curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null; }

printf '\n=== Deployment verification — %s ===\n\n' "$base"

# --- 1. health -------------------------------------------------------------
health="$(curl -sS --max-time 15 "$base/healthz" 2>/dev/null || true)"
[[ "$health" == *'"ok":true'* ]] && check "/healthz reports healthy" 1 "$health" \
  || check "/healthz reports healthy" 0 "${health:-no response}"

auth_on=0
[[ "$health" == *'"consoleAuth":true'* ]] && auth_on=1

# --- 2. console authentication --------------------------------------------
code="$(status "$base/")"
if [[ "$auth_on" == "1" ]]; then
  [[ "$code" == "401" ]] && check "the agent console demands credentials" 1 "HTTP $code" \
    || check "the agent console demands credentials" 0 "HTTP $code — the console is OPEN"

  if [[ -n "${CONSOLE_PASSWORD:-}" ]]; then
    good="$(status -u "${CONSOLE_USER:-agent}:${CONSOLE_PASSWORD}" "$base/")"
    [[ "$good" == "200" ]] && check "…and accepts the configured credentials" 1 "HTTP $good" \
      || check "…and accepts the configured credentials" 0 "HTTP $good"

    bad="$(status -u "${CONSOLE_USER:-agent}:definitely-not-the-password" "$base/")"
    [[ "$bad" == "401" ]] && check "…and rejects a wrong password" 1 "HTTP $bad" \
      || check "…and rejects a wrong password" 0 "HTTP $bad"
  else
    printf '  SKIP  credential check — CONSOLE_PASSWORD not in the environment\n'
  fi
else
  check "console authentication is enabled" 0 "OPEN CONSOLE — set CONSOLE_PASSWORD before exposing this"
fi

  # A path prefix the auth check treats as public must not be usable as a way
  # around it. Regression from the 2026-09-03 security review.
  if [[ "$auth_on" == "1" ]]; then
    walk="$(status --path-as-is "$base/download/../portal.html")"
    [[ "$walk" == "401" || "$walk" == "404" ]] \
      && check "…and cannot be walked around with /download/../portal.html" 1 "HTTP $walk" \
      || check "…and cannot be walked around with /download/../portal.html" 0 "HTTP $walk — auth bypass"
  fi

# --- 3. what the END USER must reach without credentials -------------------
join="$(status "$base/j/000000")"
[[ "$join" == "200" ]] && check "the join page is reachable without credentials" 1 "HTTP $join" \
  || check "the join page is reachable without credentials" 0 "HTTP $join"

dl_headers="$(curl -sSI --max-time 30 "$base/download/HelpdeskAnywhere.exe" 2>/dev/null || true)"
dl_code="$(printf '%s' "$dl_headers" | head -1 | awk '{print $2}')"
[[ "$dl_code" == "200" ]] && check "the applet download is reachable without credentials" 1 "HTTP $dl_code" \
  || check "the applet download is reachable without credentials" 0 "HTTP ${dl_code:-none}"

printf '%s' "$dl_headers" | grep -qi 'content-type: *application/octet-stream' \
  && check "…and is served as a binary download" 1 \
  || check "…and is served as a binary download" 0 "$(printf '%s' "$dl_headers" | grep -i content-type || echo 'no content-type')"

magic="$(curl -sS --max-time 30 -r 0-1 "$base/download/HelpdeskAnywhere.exe" 2>/dev/null | head -c2 || true)"
[[ "$magic" == "MZ" ]] && check "…and really is a Windows executable (MZ header)" 1 \
  || check "…and really is a Windows executable (MZ header)" 0 "got '${magic:-nothing}'"

# --- 4. the WebSocket upgrade survives the proxy ---------------------------
# The single most common way a reverse-proxied deployment of this shape breaks.
ws_key="$(head -c16 /dev/urandom | base64)"
ws_response="$(curl -sSi --max-time 15 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: $ws_key" -H "Sec-WebSocket-Version: 13" \
  "$base/ws" 2>/dev/null | head -1 || true)"
[[ "$ws_response" == *"101"* ]] && check "the /ws upgrade completes through the proxy" 1 "$(echo "$ws_response" | tr -d '\r')" \
  || check "the /ws upgrade completes through the proxy" 0 "${ws_response:-no response} (expected 101)"

# A browser page on another site must not be able to open the relay in an
# agent's browser (cross-site WebSocket hijacking). A client that sends no
# Origin at all — the applet, and the check above — must still be accepted.
origin_response="$(curl -sSi --max-time 15 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: $ws_key" -H "Sec-WebSocket-Version: 13" \
  -H "Origin: https://not-this-site.example" \
  "$base/ws" 2>/dev/null | head -1 || true)"
[[ "$origin_response" == *"403"* ]] && check "…and refuses a foreign browser Origin" 1 "$(echo "$origin_response" | tr -d '\r')" \
  || check "…and refuses a foreign browser Origin" 0 "${origin_response:-no response} (expected 403)"

# --- 5. transport ----------------------------------------------------------
if [[ "$base" == https://* ]]; then
  curl -fsS -o /dev/null --max-time 15 "$base/healthz" 2>/dev/null \
    && check "TLS certificate validates" 1 \
    || check "TLS certificate validates" 0 "curl rejected the certificate"
  check "downloads will not be blocked by Chrome (served over HTTPS)" 1
else
  printf '  NOTE  %s is plain HTTP — fine locally; Chrome blocks .exe downloads over HTTP,\n' "$base"
  printf '        and credential-mode elevation is hard-refused on a non-wss connection.\n'
fi

printf '%s' "$(curl -sSI --max-time 15 "$base/healthz" 2>/dev/null || true)" | grep -qi 'x-powered-by' \
  && check "no x-powered-by header leaking the stack" 0 \
  || check "no x-powered-by header leaking the stack" 1

# The app sets these, but a reverse proxy is perfectly capable of dropping a
# header on its way out. Ask the deployment, not the source. The join page is
# the one that matters: it is unauthenticated and it offers an executable.
join_headers="$(curl -sSI --max-time 15 "$base/j/482913" 2>/dev/null || true)"
printf '%s' "$join_headers" | grep -qi "^content-security-policy:.*script-src 'self'" \
  && check "the join page carries a CSP locking scripts to 'self'" 1 \
  || check "the join page carries a CSP locking scripts to 'self'" 0
printf '%s' "$join_headers" | grep -i '^content-security-policy:' | grep -qi 'unsafe-inline.*script-src\|script-src[^;]*unsafe-inline' \
  && check "…and does not re-admit inline script" 0 \
  || check "…and does not re-admit inline script" 1

printf '\n  %d passed, %d failed\n\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
