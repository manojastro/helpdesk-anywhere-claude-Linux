#!/usr/bin/env bash
# Cloud migration — Phase 6. Run this on the NEW (target) VM, once, before
# restore-new-vm.sh. Target OS: Ubuntu 22.04 or 24.04 LTS, x86_64.
#
# Installs only what this repo actually needs: git, curl, ca-certificates,
# Docker Engine + the Compose plugin. Nothing else. Provider-specific steps
# (VM creation, security groups, reserved IPs, DNS) are NOT here — see
# MIGRATION_DNS.md and CLOUD_MIGRATION_RUNBOOK.md for those.
#
#   ./scripts/cloud-migration/bootstrap-new-vm.sh
#
# Idempotent: safe to re-run. Does not create or touch any secrets.
set -euo pipefail

if [[ "$(id -u)" -eq 0 ]]; then
  echo "error: run this as your normal user (it uses sudo where needed), not as root" >&2
  exit 1
fi

. /etc/os-release 2>/dev/null || { echo "error: cannot read /etc/os-release" >&2; exit 1; }
if [[ "$ID" != "ubuntu" ]] || [[ "$VERSION_ID" != "22.04" && "$VERSION_ID" != "24.04" ]]; then
  echo "warning: this script targets Ubuntu 22.04/24.04; detected $PRETTY_NAME. Continuing anyway." >&2
fi

echo "→ updating apt package index"
sudo apt-get update -y

echo "→ installing base dependencies"
sudo apt-get install -y \
  git \
  curl \
  ca-certificates \
  gnupg

if command -v docker >/dev/null 2>&1; then
  echo "→ Docker already installed: $(docker --version)"
else
  echo "→ installing Docker Engine + Compose plugin (official Docker apt repo)"
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/ubuntu/gpg" \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg

  arch="$(dpkg --print-architecture)"
  codename="$VERSION_CODENAME"
  echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${codename} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

  sudo apt-get update -y
  sudo apt-get install -y \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin
fi

echo "→ enabling Docker at boot"
sudo systemctl enable --now docker

if ! groups "$USER" | grep -qw docker; then
  echo "→ adding $USER to the docker group (takes effect on next login/shell)"
  sudo usermod -aG docker "$USER"
  echo "  NOTE: log out and back in (or run 'newgrp docker') before using docker without sudo"
fi

echo "→ verifying Docker"
sudo docker --version
sudo docker compose version

echo "→ creating standard project location"
mkdir -p "$HOME/hda-migration"

echo
echo "────────────────────────────────────────────────────────────────────────"
echo "  Bootstrap complete on $(hostname)."
echo "  Next: clone the repo and run restore-new-vm.sh"
echo "    git clone https://github.com/manojastro/helpdesk-anywhere-claude-Linux.git"
echo "    cd helpdesk-anywhere-claude-Linux"
echo "    ./scripts/cloud-migration/restore-new-vm.sh <path-to-migration-archive>"
echo "────────────────────────────────────────────────────────────────────────"
