#!/usr/bin/env bash
# Bring the stack up behind a temporary ngrok tunnel (PLAN 7.8, brought forward).
#
#   ./scripts/deploy-ngrok.sh
#
# Why this exists: Phase 7's permanent answer is a DuckDNS hostname with Caddy
# doing Let's Encrypt (PLAN 7.2/7.3), which needs an account and a token. This
# gets a real HTTPS URL in about a minute without any DNS, so the Windows manual
# tests are not blocked waiting for it — and Chrome will not block the .exe
# download, which it does over plain HTTP.
#
# Nothing here is hard-coded: the authtoken and the console password come from
# .env, which is gitignored. Migrating to DuckDNS later is `scripts/deploy.sh` —
# same app service, same image, no application-code change (DECISIONS.md D-007).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# The container must run as a uid that can write the bind-mounted ./audit
# directory, or the audit log fails silently (CLAUDE.md constraint #5).
export HOST_UID="${HOST_UID:-$(id -u)}"
export HOST_GID="${HOST_GID:-$(id -g)}"

allow_open_console=0
[[ "${1:-}" == "--allow-open-console" ]] && allow_open_console=1

# .env is data, not a shell script — read keys out of it rather than sourcing it.
read_env() {
  [[ -f .env ]] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env \
    | tail -n1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

if [[ ! -f .env ]]; then
  echo "error: .env not found. Copy .env.example to .env first." >&2
  exit 1
fi

if [[ -z "$(read_env NGROK_AUTHTOKEN)" ]]; then
  cat >&2 <<'MSG'
error: NGROK_AUTHTOKEN is not set in .env

  1. Sign in at https://dashboard.ngrok.com (free).
  2. Copy the authtoken from "Your Authtoken".
  3. Put it in .env as NGROK_AUTHTOKEN=... — never in a tracked file.

  Optional but recommended: reserve the free static domain on that dashboard and
  set NGROK_URL=https://<your>.ngrok-free.app, so the URL survives a restart and
  the applet does not have to be rebuilt each time.
MSG
  exit 1
fi

# An open console on a public URL is a working remote-control panel for whoever
# finds it — exactly what CLAUDE.md 7.5 warns about. Refuse by default.
if [[ -z "$(read_env CONSOLE_PASSWORD)" && "$allow_open_console" -eq 0 ]]; then
  cat >&2 <<'MSG'
error: CONSOLE_PASSWORD is not set, and this deployment will be reachable from
       the public internet.

  The agent console has no login of its own (PLAN.md puts that out of scope), so
  this shared password is the only thing between the tunnel URL and a working
  remote-control console.

  Set CONSOLE_PASSWORD in .env, or pass --allow-open-console if you genuinely
  want it open.
MSG
  exit 1
fi

echo "→ building and starting the stack (ngrok profile)"
docker compose --profile ngrok up -d --build

echo "→ waiting for the tunnel"
public_url=""
for _ in $(seq 1 30); do
  public_url="$(curl -fsS --max-time 3 http://127.0.0.1:4040/api/tunnels 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const t=JSON.parse(d).tunnels||[];const h=t.find(x=>x.public_url?.startsWith("https"))||t[0];process.stdout.write(h?.public_url??"")}catch{}})' || true)"
  [[ -n "$public_url" ]] && break
  sleep 2
done

if [[ -z "$public_url" ]]; then
  echo "error: the tunnel did not come up. Check: docker compose logs ngrok" >&2
  docker compose --profile ngrok ps
  exit 1
fi

host="${public_url#https://}"
echo "→ tunnel is up: $public_url"

# Rebuild the applet so the .exe dials THIS tunnel. Skipped when the .NET SDK is
# absent (a deployment host has no reason to have it) — the URL is printed either
# way so it can be baked on the build machine.
if command -v dotnet >/dev/null 2>&1 || [[ -x "$HOME/.dotnet/dotnet" ]]; then
  echo "→ rebuilding the applet with SERVER_URL=wss://$host/ws"
  SERVER_URL="wss://$host/ws" "$repo_root/scripts/build-windows.sh"
else
  cat <<MSG
  NOTE: the .NET SDK is not on this host, so the .exe was not rebuilt. On the
        build machine run:
          SERVER_URL="wss://$host/ws" ./scripts/build-windows.sh
        The end user can also type the address into the applet's own field.
MSG
fi

echo
echo "→ verifying the deployment"
"$repo_root/scripts/verify-deployment.sh" "$public_url" || true

cat <<MSG

────────────────────────────────────────────────────────────────────────
  Agent console   $public_url/
                  sign in as "$(read_env CONSOLE_USER || echo agent)"
  Join link       $public_url/j/<code>
  Applet download $public_url/download/HelpdeskAnywhere.exe

  Logs      docker compose --profile ngrok logs -f
  Audit     ./scripts/verify-audit.sh
  Stop      docker compose --profile ngrok down
────────────────────────────────────────────────────────────────────────
MSG
