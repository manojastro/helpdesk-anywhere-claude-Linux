#!/usr/bin/env bash
# Cloud migration — Phase 7. Run this on the NEW (target) VM, after
# bootstrap-new-vm.sh, with the migration archive uploaded.
#
#   ./scripts/cloud-migration/restore-new-vm.sh /path/to/hda-migration-<ts>.tar.gz
#
# What it does, in order: validates inputs, ensures the repo is checked out
# at the exact commit the backup was taken from, restores .env (never
# clobbering one that's already there without backing it up first), restores
# audit logs, staging config, the golden artifacts and the PostgreSQL dumps,
# restores the reference .exe, fixes ownership/permissions, validates the
# compose config, loads the live database dump (if any) before the app first
# starts, starts the stack, and runs a health check.
#
# Idempotent: safe to re-run. Never deletes existing data. Never overwrites
# an existing .env without saving the previous one first.
set -euo pipefail

# This script checks out another commit of the repo it lives in, which rewrites
# this very file mid-run — and bash reads scripts incrementally. Run from a
# private copy of the migration tools instead, so the checkout can't change the
# code that is executing (or drop restore-database.sh from under it).
if [[ -z "${HDA_RESTORE_TOOLS:-}" ]]; then
  tools_copy="$(mktemp -d)"
  cp -a "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/." "$tools_copy/"
  HDA_RESTORE_TOOLS="$tools_copy" exec bash "$tools_copy/$(basename "${BASH_SOURCE[0]}")" "$@"
fi
tools_dir="$HDA_RESTORE_TOOLS"

default_repo_url="https://github.com/manojastro/helpdesk-anywhere-claude-Linux.git"
repo_url="${REPO_URL:-$default_repo_url}"

usage() {
  cat >&2 <<EOF
usage: $(basename "$0") <migration-archive.tar.gz> [target-commit-sha] [--no-start]

  <migration-archive.tar.gz>  produced by backup-current-vm.sh
  [target-commit-sha]         defaults to the SHA recorded in the archive's
                               manifests/MIGRATION_MANIFEST.md
  --no-start                  restore files only; don't bring the stack up

Env overrides:
  REPO_URL   git remote to clone from (default: $default_repo_url)

By default this script brings the stack up on the 'cloudflared' profile —
it needs no DNS change and no account, so the new VM can be started and
verified entirely independently of the old one (MIGRATION_DNS.md's "deploy
and test before cutover" sequence). Switch to the permanent DuckDNS/Caddy
profile yourself with ./scripts/deploy.sh once you're ready to cut over.
EOF
  exit 1
}

no_start=0
args=()
for a in "$@"; do
  if [[ "$a" == "--no-start" ]]; then no_start=1; else args+=("$a"); fi
done
[[ ${#args[@]} -ge 1 ]] || usage
archive="${args[0]}"
target_commit="${args[1]:-}"

[[ -f "$archive" ]] || { echo "error: archive not found: $archive" >&2; exit 1; }
if [[ -f "${archive}.sha256" ]]; then
  echo "→ verifying archive checksum"
  ( cd "$(dirname "$archive")" && sha256sum -c "$(basename "${archive}.sha256")" )
fi

work="$(mktemp -d)"
trap 'rm -rf "$work" "$tools_dir"' EXIT
echo "→ extracting archive to $work"
tar xzf "$archive" -C "$work"

for d in config audit generated manifests; do
  [[ -d "$work/$d" ]] || { echo "error: archive is missing expected directory '$d'" >&2; exit 1; }
done

manifest="$work/manifests/MIGRATION_MANIFEST.md"
if [[ -z "$target_commit" && -f "$manifest" ]]; then
  target_commit="$(grep -m1 -oE '^- Commit SHA: [0-9a-f]{7,40}' "$manifest" | awk '{print $NF}')"
fi
[[ -n "$target_commit" ]] || { echo "error: could not determine target commit; pass it explicitly" >&2; usage; }
echo "→ target commit: $target_commit"
dev_branch=""
[[ -f "$manifest" ]] && dev_branch="$(sed -nE 's/^- Development branch: (.+)$/\1/p' "$manifest" | head -1)"

# ---------------------------------------------------------- repo checkout
if [[ -f docker-compose.yml && -f CLAUDE.md && -d .git ]]; then
  repo_root="$(pwd)"
  echo "→ using current directory as the repo: $repo_root"
elif [[ -f "../docker-compose.yml" ]]; then
  echo "error: run this from inside the repo root, not a subdirectory" >&2
  exit 1
else
  clone_dir="$HOME/helpdesk-anywhere-claude-Linux"
  if [[ -d "$clone_dir/.git" ]]; then
    echo "→ repo already cloned at $clone_dir"
  else
    echo "→ cloning $repo_url into $clone_dir"
    git clone "$repo_url" "$clone_dir"
  fi
  repo_root="$clone_dir"
fi
cd "$repo_root"

echo "→ fetching and checking out $target_commit"
git fetch --all --tags --quiet
current_sha="$(git rev-parse HEAD)"
if [[ "$current_sha" != "$target_commit" ]]; then
  if ! git diff --quiet --ignore-submodules HEAD --; then
    echo "error: working tree has uncommitted changes; refusing to check out a different commit." >&2
    echo "       commit, stash, or discard them first." >&2
    exit 1
  fi
  git checkout --quiet "$target_commit"
fi
echo "→ repo is at $(git rev-parse HEAD) ($(git rev-parse --abbrev-ref HEAD))"

# Older commits (main included) don't gitignore the staging secrets or the
# database dumps this restore places. Exclude them locally so no `git add -A`
# on any branch can commit chat transcripts or the gate password.
for p in /backups/ /.staging-gate/ /.staging-audit/ /.env.staging '/.env.pre-restore.*'; do
  grep -qxF "$p" .git/info/exclude 2>/dev/null || echo "$p" >> .git/info/exclude
done

# ---------------------------------------------------------------- .env
if [[ -f .env ]]; then
  backup_name=".env.pre-restore.$(date -u +%Y%m%dT%H%M%SZ)"
  cp .env "$backup_name"
  echo "→ existing .env found — preserved as $backup_name before restoring"
fi
if [[ -f "$work/config/.env" ]]; then
  install -m 600 "$work/config/.env" .env
  echo "→ restored .env (permissions 600, contents not shown)"
else
  echo "→ WARNING: no .env in archive — copy .env.example to .env and fill it in manually" >&2
fi

# Staging (scripts/staging.sh) — only where none exists yet: a staging .env
# already here belongs to a staging database already here.
if [[ -f "$work/config/.env.staging" && ! -f .env.staging ]]; then
  install -m 600 "$work/config/.env.staging" .env.staging
  echo "→ restored .env.staging (permissions 600, contents not shown)"
fi
if [[ -d "$work/config/staging-gate" && ! -d .staging-gate ]]; then
  cp -a "$work/config/staging-gate" .staging-gate
  echo "→ restored .staging-gate/ (MT-10 gate password; contents not shown)"
fi

for f in Caddyfile docker-compose.local.yml docker-compose.caddy-local.yml; do
  # These ship in the git checkout already; only restore if genuinely missing
  # (e.g. a local-only override someone had that never got committed).
  if [[ ! -f "$f" && -f "$work/config/$f" ]]; then
    cp "$work/config/$f" "$f"
    echo "→ restored $f (was missing from the checkout)"
  fi
done

# ---------------------------------------------------------------- audit/
mkdir -p audit
if compgen -G "$work/audit/*.jsonl" >/dev/null 2>&1; then
  copied=0
  for f in "$work"/audit/*.jsonl; do
    base="$(basename "$f")"
    if [[ -f "audit/$base" ]]; then
      echo "→ audit/$base already exists locally — leaving it, not overwriting"
    else
      cp "$f" "audit/$base"
      copied=$((copied + 1))
    fi
  done
  echo "→ restored $copied audit log file(s) (existing files were never overwritten)"
fi
if compgen -G "$work/audit/staging/*.jsonl" >/dev/null 2>&1; then
  mkdir -p .staging-audit
  for f in "$work"/audit/staging/*.jsonl; do
    [[ -f ".staging-audit/$(basename "$f")" ]] || cp "$f" .staging-audit/
  done
  echo "→ restored staging audit logs into .staging-audit/ (existing files kept)"
fi

# ---------------------------------------------------------------- artifacts/
# Golden checkpoint copies and the real-Windows-verified slot. These cannot be
# rebuilt (non-deterministic .NET publish), so never overwrite what is there.
artifacts_dst="${HDA_ARTIFACTS_DIR:-$HOME/hda-artifacts}"
if [[ -d "$work/artifacts" ]] && compgen -G "$work/artifacts/*" >/dev/null 2>&1; then
  mkdir -p "$artifacts_dst"
  # GNU tar's --skip-old-files: keeps modes, never replaces an existing file.
  tar -C "$work/artifacts" -cf - . | tar -C "$artifacts_dst" -xf - --skip-old-files
  echo "→ restored golden artifacts into $artifacts_dst (existing files kept)"
fi

# ---------------------------------------------------------- claude-memory/
# Claude Code keys project memory by the repo's path, so it lands under this
# checkout's slug. Clone to the same path as the old VM ("$HOME/Helpdesk
# Anywhere") and the slug — and the compose project name — stay identical.
if [[ -d "$work/claude-memory" ]] && compgen -G "$work/claude-memory/*" >/dev/null 2>&1; then
  memory_dst="$HOME/.claude/projects/$(printf '%s' "$repo_root" | sed 's/[^A-Za-z0-9]/-/g')/memory"
  mkdir -p "$memory_dst"
  tar -C "$work/claude-memory" -cf - . | tar -C "$memory_dst" -xf - --skip-old-files
  echo "→ restored Claude Code project memory into $memory_dst (existing files kept)"
fi

# ---------------------------------------------------------------- data/
# PostgreSQL dumps go to backups/ (gitignored). They contain chat transcripts.
if compgen -G "$work/data/*.dump" >/dev/null 2>&1; then
  mkdir -p backups
  chmod 700 backups
  for f in "$work"/data/*.dump; do
    if [[ -f "backups/$(basename "$f")" ]]; then
      echo "→ backups/$(basename "$f") already exists — leaving it"
    else
      install -m 600 "$f" "backups/$(basename "$f")"
      echo "→ placed database dump backups/$(basename "$f")"
    fi
  done
fi

# ---------------------------------------------------------------- generated/
mkdir -p server/public/download
if compgen -G "$work/generated/*.exe" >/dev/null 2>&1; then
  cp "$work"/generated/*.exe server/public/download/
  echo "→ restored reference .exe — REBUILD it once PUBLIC_HOST is set for this VM"
  echo "  (the old .exe dials the OLD tunnel/host and will not connect from here)"
fi
if compgen -G "$work/generated/*.ps1" >/dev/null 2>&1; then
  cp "$work"/generated/*.ps1 server/public/download/
fi

# ---------------------------------------------------------- ownership/perms
export HOST_UID="${HOST_UID:-$(id -u)}"
export HOST_GID="${HOST_GID:-$(id -g)}"
chmod 600 .env 2>/dev/null || true
if ! chown -R "$HOST_UID:$HOST_GID" audit 2>/dev/null; then
  sudo chown -R "$HOST_UID:$HOST_GID" audit
fi
echo "→ audit/ ownership set to ${HOST_UID}:${HOST_GID}"

# ---------------------------------------------------------- validate compose
echo "→ validating docker compose configuration"
source "$repo_root/scripts/lib/envfile.sh"
PUBLIC_HOST="$(read_env PUBLIC_HOST || true)"
if [[ -z "$PUBLIC_HOST" ]]; then
  echo "error: PUBLIC_HOST is not set in .env — set it before starting the stack" >&2
  exit 1
fi
if ! docker compose --profile tls config >/dev/null; then
  echo "error: the compose config does not validate against the restored .env." >&2
  echo "       Commit $(git rev-parse --short HEAD) needs every variable named above;" >&2
  echo "       the admin-portal commits add POSTGRES_PASSWORD, ADMIN_PUBLIC_HOST and" >&2
  echo "       ENTRA_* (see .env.example and docs/ADMIN_PORTAL.md)." >&2
  exit 1
fi
has_db=0
docker compose config --services 2>/dev/null | grep -qx db && has_db=1

staging_hint() {
  [[ -f backups/hda-staging.dump ]] || return 0
  echo
  echo "  Staging data was carried (backups/hda-staging.dump). To bring staging back:"
  echo "    git checkout ${dev_branch:-feature/admin-portal}"
  echo "    ./scripts/cloud-migration/restore-database.sh backups/hda-staging.dump staging"
  echo "    ./scripts/staging.sh up"
}
verified_hint() {
  if ! compgen -G "$artifacts_dst/real-windows-verified/*.exe" >/dev/null 2>&1; then
    echo
    echo "  WARNING: the real-Windows-verified .exe (sha256 5ff97646…) is not archived."
    echo "  Copy it from the Windows test machine into $artifacts_dst/real-windows-verified/"
  fi
}

if [[ "$no_start" -eq 1 ]]; then
  echo
  echo "────────────────────────────────────────────────────────────────────────"
  echo "  Restore complete (--no-start). Repo: $repo_root"
  echo "  Commit: $(git rev-parse HEAD)"
  echo
  echo "  Start it yourself when ready:"
  echo "    ./scripts/deploy-cloudflared.sh      # no DNS needed, safe to test with"
  echo "    ./scripts/deploy.sh                  # tls profile (DuckDNS + Caddy, permanent cutover)"
  echo "    ./scripts/deploy-ngrok.sh            # ngrok profile"
  if [[ -f backups/helpdeskanywhere.dump ]]; then
    echo
    echo "  Load the live database BEFORE the first start:"
    echo "    ./scripts/cloud-migration/restore-database.sh backups/helpdeskanywhere.dump live"
  fi
  staging_hint
  verified_hint
  echo "────────────────────────────────────────────────────────────────────────"
  exit 0
fi

if [[ -f backups/helpdeskanywhere.dump ]]; then
  if [[ "$has_db" -eq 1 ]]; then
    echo "→ loading the live database before the app's first start"
    "$tools_dir/restore-database.sh" backups/helpdeskanywhere.dump live
  else
    echo "→ WARNING: a live database dump was carried but commit $(git rev-parse --short HEAD)" >&2
    echo "  has no db service. It is kept in backups/ for when the admin portal is deployed." >&2
  fi
fi

echo "→ starting the stack on the cloudflared profile (no DNS/account required)"
if ! "$repo_root/scripts/deploy-cloudflared.sh"; then
  echo "error: deploy-cloudflared.sh failed (see message above — commonly a" >&2
  echo "       missing/placeholder CONSOLE_PASSWORD in the restored .env)." >&2
  echo "       Fix .env and re-run: ./scripts/deploy-cloudflared.sh" >&2
  exit 1
fi

echo
echo "→ container status"
docker compose ps

new_public_host="$(read_env PUBLIC_HOST)"
echo
echo "→ health check against https://$new_public_host/healthz"
if curl -fsS --max-time 10 "https://$new_public_host/healthz"; then
  echo
  echo "→ health check PASSED"
else
  echo "→ health check FAILED — inspect: docker compose logs app" >&2
fi

echo
echo "────────────────────────────────────────────────────────────────────────"
echo "  Restore + start complete. Repo: $repo_root"
echo "  Commit: $(git rev-parse HEAD)"
echo "  Temporary URL: https://$new_public_host"
echo
echo "  This is a TEST endpoint on the new VM, independent of the old VM's tunnel."
echo "  Next: run the checks in MIGRATION_TEST_PLAN.md, then follow MIGRATION_DNS.md"
echo "  to cut over to the permanent tls/DuckDNS profile."
echo
echo "  Full verification: ./scripts/cloud-migration/verify-migration.sh https://$new_public_host $(git rev-parse HEAD)"
staging_hint
verified_hint
echo "────────────────────────────────────────────────────────────────────────"
