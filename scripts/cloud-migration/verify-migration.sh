#!/usr/bin/env bash
# Cloud migration — Phase 10. Run this on the NEW (target) VM after
# restore-new-vm.sh (and again after DNS cutover).
#
#   ./scripts/cloud-migration/verify-migration.sh https://<host> [expected-commit-sha]
#
# Prints PASS / FAIL / WARNING for each check and exits non-zero if any
# check FAILs. Never prints secret values.
set -uo pipefail

url="${1:-}"
expected_commit="${2:-}"

if [[ -z "$url" ]]; then
  echo "usage: $(basename "$0") https://<host> [expected-commit-sha]" >&2
  exit 1
fi
host="${url#https://}"
host="${host#http://}"
host="${host%%/*}"

pass=0
fail=0
warn=0
result() {
  local status="$1" msg="$2"
  case "$status" in
    PASS) printf '  PASS     %s\n' "$msg"; pass=$((pass+1)) ;;
    FAIL) printf '  FAIL     %s\n' "$msg"; fail=$((fail+1)) ;;
    WARN) printf '  WARNING  %s\n' "$msg"; warn=$((warn+1)) ;;
  esac
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root" 2>/dev/null || true

echo "Verifying: $url"
echo "────────────────────────────────────────────────────────────────────────"

# 1. Git commit
if [[ -d .git ]]; then
  actual_commit="$(git rev-parse HEAD 2>/dev/null || echo "")"
  if [[ -n "$expected_commit" ]]; then
    if [[ "$actual_commit" == "$expected_commit"* || "$expected_commit" == "$actual_commit"* ]]; then
      result PASS "git commit matches source ($actual_commit)"
    else
      result FAIL "git commit mismatch: here=$actual_commit expected=$expected_commit"
    fi
  else
    result WARN "no expected commit given — current HEAD is $actual_commit"
  fi
else
  result FAIL "not inside a git repository"
fi

# 2. Docker containers running
running="$(docker compose ps --status running --services 2>/dev/null || true)"
if echo "$running" | grep -qx app; then
  result PASS "app container is running"
else
  result FAIL "app container is not running"
fi

# 3. Docker container health
health="$(docker inspect --format '{{.State.Health.Status}}' \
  "$(docker compose ps -q app 2>/dev/null)" 2>/dev/null || echo "unknown")"
if [[ "$health" == "healthy" ]]; then
  result PASS "app container healthcheck: healthy"
elif [[ "$health" == "starting" ]]; then
  result WARN "app container healthcheck: starting (recheck shortly)"
else
  result FAIL "app container healthcheck: $health"
fi

# 4. Expected ports listening (only meaningful for the tls profile)
if echo "$running" | grep -qx caddy; then
  for p in 80 443; do
    if (sudo ss -tln 2>/dev/null || ss -tln 2>/dev/null) | grep -q ":$p "; then
      result PASS "port $p is listening (caddy)"
    else
      result FAIL "port $p is not listening (caddy)"
    fi
  done
else
  result WARN "caddy/tls profile not active — skipping port 80/443 checks"
fi

# 5. HTTP endpoint (plain HTTP should redirect or simply not be required)
if curl -fsS --max-time 8 -o /dev/null "http://$host/healthz" 2>/dev/null; then
  result PASS "HTTP endpoint reachable"
else
  result WARN "HTTP endpoint not reachable on :80 (expected unless using the tls profile)"
fi

# 6. HTTPS endpoint
if curl -fsS --max-time 8 "https://$host/healthz" >/tmp/hda-healthz.$$ 2>/dev/null; then
  result PASS "HTTPS /healthz reachable"
  body="$(cat /tmp/hda-healthz.$$)"
  rm -f /tmp/hda-healthz.$$
  if echo "$body" | grep -q '"ok":true'; then
    result PASS "/healthz reports ok:true"
  else
    result FAIL "/healthz did not report ok:true — got: $body"
  fi
else
  result FAIL "HTTPS /healthz not reachable"
fi

# 7. WebSocket endpoint (upgrade handshake reachability, not a full session)
ws_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "https://$host/ws" 2>/dev/null || echo "000")"
if [[ "$ws_code" == "101" || "$ws_code" == "400" || "$ws_code" == "426" ]]; then
  result PASS "/ws endpoint responds to an upgrade attempt (HTTP $ws_code)"
else
  result FAIL "/ws endpoint unreachable or unexpected response (HTTP $ws_code)"
fi

# 8. Agent console reachable
console_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://$host/" 2>/dev/null || echo "000")"
if [[ "$console_code" =~ ^(200|401)$ ]]; then
  result PASS "agent console responds (HTTP $console_code)"
else
  result FAIL "agent console unreachable (HTTP $console_code)"
fi

# 9. Session creation — not automated (requires console credentials); manual step.
result WARN "session creation not automated — verify manually (MIGRATION_TEST_PLAN.md)"

# 10. Required files
for f in docker-compose.yml Caddyfile .env server/public/download; do
  if [[ -e "$f" ]]; then
    result PASS "required path present: $f"
  else
    result FAIL "required path missing: $f"
  fi
done

# 11. Audit directory writable
if [[ -d audit ]] && touch audit/.write-test 2>/dev/null; then
  rm -f audit/.write-test
  result PASS "audit/ is writable"
else
  result FAIL "audit/ is missing or not writable"
fi

# 12. Disk space
avail_kb="$(df -Pk / | awk 'NR==2 {print $4}')"
avail_gb=$((avail_kb / 1024 / 1024))
if [[ "$avail_gb" -ge 5 ]]; then
  result PASS "disk space OK (${avail_gb}G free on /)"
else
  result WARN "disk space low (${avail_gb}G free on /)"
fi

# 13. Memory
mem_avail_mb="$(free -m | awk '/^Mem:/ {print $7}')"
if [[ "$mem_avail_mb" -ge 512 ]]; then
  result PASS "memory OK (${mem_avail_mb}M available)"
else
  result WARN "memory tight (${mem_avail_mb}M available)"
fi

# 14. CPU
cpu_count="$(nproc)"
result PASS "CPU count: $cpu_count core(s)"

# 15. SSL certificate
if cert_end="$(echo | openssl s_client -connect "$host:443" -servername "$host" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"; then
  if [[ -n "$cert_end" ]]; then
    result PASS "TLS certificate present, expires: $cert_end"
  else
    result WARN "could not read TLS certificate expiry (may be a non-443 tunnel, e.g. cloudflared)"
  fi
else
  result WARN "could not open TLS connection on :443 (expected for cloudflared/ngrok profiles)"
fi

# 16. DNS resolution
resolved="$(dig +short "$host" 2>/dev/null | tail -1)"
if [[ -n "$resolved" ]]; then
  result PASS "DNS resolves: $host -> $resolved"
else
  result WARN "DNS did not resolve for $host (expected for a *.trycloudflare.com / ngrok host you haven't pointed DNS at)"
fi

echo "────────────────────────────────────────────────────────────────────────"
echo "  $pass PASS, $warn WARNING, $fail FAIL"
echo "────────────────────────────────────────────────────────────────────────"

[[ "$fail" -eq 0 ]]
