#!/usr/bin/env bash
# Bring the stack up behind a temporary Cloudflare quick tunnel (DECISIONS.md D-011).
#
#   ./scripts/deploy-cloudflared.sh
#
# Why this exists: ngrok's free tier has a monthly bandwidth cap, and on
# 2026-09-05 this deployment hit it (ERR_NGROK_725) with both Windows manual tests
# still owed a retest. This applet is a 66 MB download and every screen frame of
# every session crosses the same tunnel, so that cap is a poor fit for what the
# tool actually does. A Cloudflare quick tunnel has no cap, needs no account and
# no token, and still gives real HTTPS — which Chrome requires before it will
# download an .exe, and which credential-mode elevation hard-refuses to run
# without (CLAUDE.md, "Public URL and TLS").
#
# This is still a stopgap, exactly as ngrok was. Phase 7's permanent answer is a
# DuckDNS hostname with Caddy doing Let's Encrypt — `scripts/deploy.sh`, same app
# service, same image, no application-code change (DECISIONS.md D-007).
#
# THE HOSTNAME IS RANDOM AND CHANGES ON EVERY RESTART. The applet dials a URL
# baked in at build time (PLAN 2.2), so a restarted tunnel orphans every .exe
# already downloaded. Re-run this script after any restart: it reconciles
# PUBLIC_HOST and rebuilds the .exe.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# The container must run as a uid that can write the bind-mounted ./audit
# directory, or the audit log fails silently (CLAUDE.md constraint #5).
export HOST_UID="${HOST_UID:-$(id -u)}"
export HOST_GID="${HOST_GID:-$(id -g)}"

allow_open_console=0
[[ "${1:-}" == "--allow-open-console" ]] && allow_open_console=1

# Shared .env handling: read_env, harden_env, looks_placeholder, set_env.
source "$repo_root/scripts/lib/envfile.sh"

if [[ ! -f .env ]]; then
  echo "error: .env not found. Copy .env.example to .env first." >&2
  exit 1
fi

harden_env

# An open console on a public URL is a working remote-control panel for whoever
# finds it — exactly what CLAUDE.md 7.5 warns about. Refuse by default. The same
# rule as the other two deploy scripts: no tunnel is more trustworthy than
# another just because it was easier to start.
if looks_placeholder "$(read_env CONSOLE_PASSWORD)" && [[ "$allow_open_console" -eq 0 ]]; then
  cat >&2 <<'MSG'
error: CONSOLE_PASSWORD is unset or still a placeholder, and this deployment
       will be reachable from the public internet.

  The agent console has no login of its own (PLAN.md puts that out of scope), so
  this shared password is the only thing between the tunnel URL and a working
  remote-control console.

  Set CONSOLE_PASSWORD in .env, or pass --allow-open-console if you genuinely
  want it open.
MSG
  exit 1
fi

# Two tunnels would mean two public hostnames for one PUBLIC_HOST, and the /ws
# Origin policy accepts one. Stop ngrok if it is up, rather than leaving a second
# door open that nothing is reconciled against.
if docker compose ps --status running --services 2>/dev/null | grep -qx ngrok; then
  echo "→ stopping the ngrok tunnel (one public hostname at a time)"
  docker compose --profile ngrok stop ngrok >/dev/null
fi

echo "→ building and starting the stack (cloudflared profile)"
docker compose --profile cloudflared up -d --build

echo "→ waiting for the tunnel"
public_url=""
for _ in $(seq 1 45); do
  # The metrics endpoint is the structured answer; the log banner is the fallback
  # for a cloudflared build that does not serve /quicktunnel.
  hostname="$(curl -fsS --max-time 3 http://127.0.0.1:2000/quicktunnel 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).hostname??"")}catch{}})' || true)"
  if [[ -n "$hostname" ]]; then
    public_url="https://${hostname#https://}"
    break
  fi

  public_url="$(docker compose --profile cloudflared logs cloudflared 2>/dev/null \
    | grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' | tail -n1 || true)"
  [[ -n "$public_url" ]] && break

  sleep 2
done

if [[ -z "$public_url" ]]; then
  echo "error: the tunnel did not come up. Check: docker compose logs cloudflared" >&2
  docker compose --profile cloudflared ps
  exit 1
fi

host="${public_url#https://}"
echo "→ tunnel is up: $public_url"

# The app started before the tunnel existed, so it started with whatever
# PUBLIC_HOST was already in .env — necessarily stale for a random hostname.
#
# It is not cosmetic. PUBLIC_HOST is what /healthz reports, what the startup log
# prints as the join link, what build-windows.sh derives a baked wss:// URL from
# when SERVER_URL is not passed, and one of the two hosts the /ws Origin policy
# accepts. It also decides whether index.ts considers this deployment public —
# the check that refuses to start with ALLOW_INSECURE_DEV set.
if [[ "$(read_env PUBLIC_HOST)" != "$host" ]]; then
  echo "→ PUBLIC_HOST was $(read_env PUBLIC_HOST); setting it to $host and restarting the app"
  set_env PUBLIC_HOST "$host"
  docker compose --profile cloudflared up -d
  for _ in $(seq 1 30); do
    curl -fsS --max-time 5 "$public_url/healthz" >/dev/null 2>&1 && break
    sleep 2
  done
fi

# Rebuild the applet so the .exe dials THIS tunnel. Skipped when the .NET SDK is
# absent — the URL is printed either way so it can be baked on the build machine.
if command -v dotnet >/dev/null 2>&1 || [[ -x "$HOME/.dotnet/dotnet" ]]; then
  echo "→ rebuilding the applet with SERVER_URL=wss://$host/ws"
  PATH="$HOME/.dotnet:$PATH" SERVER_URL="wss://$host/ws" "$repo_root/scripts/build-windows.sh"
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

exe="$repo_root/server/public/download/HelpdeskAnywhere.exe"
cat <<MSG

────────────────────────────────────────────────────────────────────────
  Agent console   $public_url/
                  sign in as "$(read_env CONSOLE_USER || echo agent)"
  Join link       $public_url/j/<code>
  Applet download $public_url/download/HelpdeskAnywhere.exe
MSG

if [[ -f "$exe" ]]; then
  cat <<MSG
  .exe sha256     $(sha256sum "$exe" | cut -d' ' -f1)
                  Get-FileHash .\\HelpdeskAnywhere.exe -Algorithm SHA256
MSG
fi

cat <<MSG

  Logs      docker compose --profile cloudflared logs -f
  Audit     ./scripts/verify-audit.sh
  Stop      docker compose --profile cloudflared down

  The hostname is random and changes on every restart of the tunnel. Re-run this
  script after a restart — the .exe has the old one baked in and will not connect.
────────────────────────────────────────────────────────────────────────
MSG
