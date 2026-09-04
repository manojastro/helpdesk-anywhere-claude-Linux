#!/usr/bin/env bash
# The local (no-tunnel) deployment, as one command instead of a compose recipe.
#
#   ./scripts/dev-local.sh up        build and start on http://127.0.0.1:8080
#   ./scripts/dev-local.sh down      stop and remove the stack
#   ./scripts/dev-local.sh restart   down, then up
#   ./scripts/dev-local.sh status    what is running, and whether it is healthy
#   ./scripts/dev-local.sh logs      follow the app log
#   ./scripts/dev-local.sh verify    run verify-deployment.sh + verify-audit.sh
#
# Why this exists rather than a documented `docker compose` line: the local
# override needs HOST_UID/HOST_GID exported or the container cannot write the
# bind-mounted ./audit directory and the server refuses to start (constraint #5).
# That was a real defect once — a hand-run stack restart-looped on any machine
# whose uid is not 1000. A wrapper is harder to get wrong than a comment.
#
# LOOPBACK ONLY. This mode is plain HTTP with TRUST_PROXY on, which must never
# face the internet: X-Forwarded-For and X-Forwarded-Proto are then trivially
# forged. Use scripts/deploy-ngrok.sh or scripts/deploy.sh to expose anything.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# The uid the container runs as, so ./audit stays writable (constraint #5).
export HOST_UID="${HOST_UID:-$(id -u)}"
export HOST_GID="${HOST_GID:-$(id -g)}"

compose=(docker compose -f docker-compose.yml -f docker-compose.local.yml)
base="http://127.0.0.1:8080"

if [[ ! -f .env ]]; then
  echo "error: .env not found. Copy .env.example to .env first:" >&2
  echo "         cp .env.example .env" >&2
  echo "       PUBLIC_HOST=127.0.0.1:8080 is the right value for this mode." >&2
  exit 1
fi

# .env holds the console password and the ngrok authtoken. Same treatment the
# deploy scripts give it (security review, 2026-09-03).
mode="$(stat -c '%a' .env 2>/dev/null || echo '')"
if [[ -n "$mode" && "$mode" != "600" ]]; then
  chmod 600 .env && echo "note: tightened .env permissions from $mode to 600"
fi

mkdir -p audit server/public/download

case "${1:-up}" in
  up)
    "${compose[@]}" up -d --build app
    echo
    echo "waiting for the health check…"
    for _ in $(seq 1 30); do
      if curl -fsS "$base/healthz" >/dev/null 2>&1; then
        echo "  ✔ $base is up"
        echo
        echo "  agent console : $base/            (CONSOLE_PASSWORD from .env)"
        echo "  join page     : $base/j/<code>"
        echo "  applet build  : ./scripts/build-windows.sh --server $base"
        echo
        echo "  NOTE: an applet built for a plain-http server cannot use"
        echo "        credential-mode elevation — it is hard-refused off TLS."
        exit 0
      fi
      sleep 1
    done
    echo "  ✘ no healthy response from $base/healthz after 30s" >&2
    "${compose[@]}" logs --tail 40 app >&2
    exit 1
    ;;

  down)    "${compose[@]}" down ;;
  restart) "$0" down; "$0" up ;;
  status)
    "${compose[@]}" ps
    echo
    curl -fsS "$base/healthz" && echo || echo "healthz: no response"
    ;;
  logs)    "${compose[@]}" logs -f app ;;
  verify)
    "$repo_root/scripts/verify-deployment.sh" "$base"
    "$repo_root/scripts/verify-audit.sh"
    ;;
  *)
    sed -n '2,16p' "$0"
    exit 2
    ;;
esac
