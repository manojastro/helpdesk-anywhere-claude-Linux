#!/usr/bin/env bash
# Cloud migration — Phase 8. Run this on the NEW (target) VM.
#
# Opens exactly the ports Helpdesk Anywhere needs and nothing else, using
# UFW when it's available. Cloud-provider firewall/security-group rules are
# a SEPARATE step this script cannot do for you — see the printed note.
#
#   ./scripts/cloud-migration/configure-firewall.sh <tls|cloudflared|ngrok>
#
# Port requirements by profile:
#   tls          — 22 (SSH), 80 (ACME HTTP-01 + HSTS redirect), 443 (HTTPS/WSS)
#   cloudflared  — 22 (SSH) only. The tunnel dials OUT; nothing needs to be
#                  opened inbound for it. (Its local metrics port 2000 and
#                  ngrok's 4040 are bound to 127.0.0.1 by docker-compose.yml
#                  and are never meant to be reachable from outside anyway.)
#   ngrok        — 22 (SSH) only, same reasoning.
set -euo pipefail

profile="${1:-}"
case "$profile" in
  tls|cloudflared|ngrok) ;;
  *)
    echo "usage: $(basename "$0") <tls|cloudflared|ngrok>" >&2
    exit 1
    ;;
esac

if ! command -v ufw >/dev/null 2>&1; then
  cat >&2 <<'EOF'
UFW is not installed. Installing it (Ubuntu):
EOF
  sudo apt-get update -y
  sudo apt-get install -y ufw
fi

echo "→ current UFW status"
sudo ufw status verbose || true

echo "→ allowing SSH (22/tcp) — do this BEFORE enabling UFW or you can lock yourself out"
sudo ufw allow 22/tcp comment 'SSH'

if [[ "$profile" == "tls" ]]; then
  echo "→ allowing HTTP (80/tcp) — required for ACME HTTP-01 + HSTS redirect"
  sudo ufw allow 80/tcp comment 'Helpdesk Anywhere HTTP/ACME'
  echo "→ allowing HTTPS (443/tcp)"
  sudo ufw allow 443/tcp comment 'Helpdesk Anywhere HTTPS/WSS'
else
  echo "→ profile '$profile' dials out; no inbound app port needs to be opened"
  echo "  (explicitly NOT opening 80/443 — nothing is listening on them in this mode)"
fi

echo "→ enabling UFW (default: deny incoming, allow outgoing)"
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw --force enable

echo
echo "→ final UFW status"
sudo ufw status verbose

cat <<EOF

────────────────────────────────────────────────────────────────────────
  UFW configured on this host for the '$profile' profile.

  IMPORTANT — this does NOT open your cloud provider's perimeter firewall
  (AWS security group, GCP firewall rule, Azure NSG, Oracle Cloud security
  list, Hetzner/DigitalOcean cloud firewall, etc). That is a separate step
  in your provider's console or CLI. Open the SAME ports there:
    - 22/tcp   always
    - 80/tcp   only for the tls profile
    - 443/tcp  only for the tls profile
  Both layers must allow a port before traffic reaches the app.
────────────────────────────────────────────────────────────────────────
EOF
