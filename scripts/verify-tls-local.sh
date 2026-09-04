#!/usr/bin/env bash
# Verify the Caddy/TLS deployment path locally, with no DNS and no Let's Encrypt.
#
#   ./scripts/verify-tls-local.sh
#
# Brings the app up behind the real Caddy service, configured from the real
# Caddyfile, with PUBLIC_HOST=localhost so Caddy signs a certificate with its own
# internal CA. Everything the `tls` profile does in production happens here —
# reverse proxy, TLS termination, the WebSocket upgrade, the /download route, the
# HSTS header — and the only difference is who signed the certificate.
#
# It does NOT prove ACME, DNS or the cloud firewall. Those are MT-05 and
# PLAN 7.2/7.4, and they need a token and a public address.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
source "$repo_root/scripts/lib/envfile.sh"

export HOST_UID="${HOST_UID:-$(id -u)}"
export HOST_GID="${HOST_GID:-$(id -g)}"
export PUBLIC_HOST=localhost

compose=(docker compose -f docker-compose.yml -f docker-compose.caddy-local.yml)
base="https://localhost:8443"

[[ -f .env ]] || { echo "error: .env not found. Copy .env.example to .env first." >&2; exit 1; }
harden_env
mkdir -p audit server/public/download

cleanup() { "${compose[@]}" down >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "→ starting app + caddy (internal CA, loopback only)"
"${compose[@]}" up -d --build app caddy >/dev/null

echo "→ waiting for TLS"
for _ in $(seq 1 40); do
  curl -fsSk --max-time 2 "$base/healthz" >/dev/null 2>&1 && break
  sleep 1
done

if ! curl -fsSk --max-time 3 "$base/healthz" >/dev/null 2>&1; then
  echo "  ✘ $base never answered" >&2
  "${compose[@]}" logs --tail 40 caddy app >&2
  exit 1
fi

# From here on the checks run to completion and report; an individual curl that
# fails IS a result, not a reason to stop. (verify-deployment.sh does the same.)
set +e

pass=0; fail=0
# pass=$((pass+1)), not ((pass++)): the latter evaluates to 0 on the first call,
# which is a non-zero exit status, which `set -e` treats as a failed command.
check() {
  if [[ "$2" == "1" ]]; then
    printf '  PASS  %s%s\n' "$1" "${3:+  — $3}"; pass=$((pass+1))
  else
    printf '  FAIL  %s%s\n' "$1" "${3:+  — $3}"; fail=$((fail+1))
  fi
}

echo
echo "=== Caddy / TLS path — $base ==="
echo

tls_version="$(echo | openssl s_client -connect 127.0.0.1:8443 -servername localhost 2>/dev/null \
  | sed -n 's/^ *Protocol *: //p' | head -1)"
check "TLS terminates at Caddy" "$([[ -n "$tls_version" ]] && echo 1 || echo 0)" "${tls_version:-none}"

issuer="$(echo | openssl s_client -connect 127.0.0.1:8443 -servername localhost 2>/dev/null \
  | sed -n 's/^issuer=//p' | head -1)"
check "…with a certificate it issued itself (internal CA, as expected here)" \
  "$([[ -n "$issuer" ]] && echo 1 || echo 0)" "${issuer:-unknown}"

hsts="$(curl -sIk "$base/healthz" | tr -d '\r' | sed -n 's/^[Ss]trict-[Tt]ransport-[Ss]ecurity: //p')"
check "HSTS is set on the TLS path (and only there)" \
  "$([[ "$hsts" == *max-age=31536000* ]] && echo 1 || echo 0)" "${hsts:-absent}"

redirect="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:8081/healthz")"
check "plain HTTP redirects to HTTPS" \
  "$([[ "$redirect" == 30* ]] && echo 1 || echo 0)" "HTTP $redirect"

code="$(curl -sk -o /dev/null -w '%{http_code}' "$base/j/123456")"
check "the join page is served through the proxy without credentials" \
  "$([[ "$code" == "200" ]] && echo 1 || echo 0)" "HTTP $code"

# Caddy serves /download itself from /srv/public, bypassing the app entirely —
# a different code path from the ngrok profile, and the one PLAN 7.3 specifies.
headers="$(curl -sIk "$base/download/HelpdeskAnywhere.exe")"
code="$(printf '%s' "$headers" | head -1 | awk '{print $2}')"
check "Caddy serves the applet directly from /srv/public" \
  "$([[ "$code" == "200" ]] && echo 1 || echo 0)" "HTTP $code"

magic="$(curl -sk --max-time 20 "$base/download/HelpdeskAnywhere.exe" | head -c 2 | xxd -p)"
check "…and it really is a Windows executable" \
  "$([[ "$magic" == "4d5a" ]] && echo 1 || echo 0)" "magic ${magic:-none}"

# The upgrade is what breaks most reverse-proxied deployments of this shape.
#
# --http1.1 is required and is not a workaround: HTTP/2 has no Upgrade header at
# all, so over an ALPN-negotiated h2 connection this request is just a GET and
# comes back 401 from the console auth. Browsers know this and open a WebSocket
# over HTTP/1.1 regardless of what the page was loaded over, so curl has to be
# told to do the same thing.
upgrade="$(curl -sik --http1.1 --max-time 5 "$base/ws" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  | head -1 | tr -d '\r')"
check "the /ws upgrade completes THROUGH Caddy" \
  "$([[ "$upgrade" == *101* ]] && echo 1 || echo 0)" "${upgrade:-no response}"

foreign="$(curl -sik --http1.1 --max-time 5 "$base/ws" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Origin: https://evil.example" | head -1 | tr -d '\r')"
check "…and a foreign browser Origin is still refused behind the proxy" \
  "$([[ "$foreign" == *403* ]] && echo 1 || echo 0)" "${foreign:-no response}"

echo
printf '  %d passed, %d failed\n\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
exit $?
