#!/usr/bin/env bash
# Cloud migration — Phase 3/5. Run this on the CURRENT (source) VM.
#
# Snapshots everything needed to recreate this Helpdesk Anywhere deployment on
# a new VM: non-secret config, .env and .env.staging (restricted perms
# preserved), audit logs, PostgreSQL dumps, the generated Windows .exe, the
# golden artifacts in ~/hda-artifacts, and a live-generated migration manifest. Does
# NOT touch the running application or any git state — read-only against the
# live deployment.
#
#   ./scripts/cloud-migration/backup-current-vm.sh
#
# Output:
#   ~/hda-migration/{config,data,audit,generated,artifacts,docker,system,manifests,restore}/
#   ~/hda-migration-<timestamp>.tar.gz          (portable archive)
#   ~/hda-migration-<timestamp>.tar.gz.sha256   (its checksum)
#
# Secrets are never printed to the console and never included unredacted in
# any generated text file. .env is copied byte-for-byte (its values are
# needed to restore the deployment) but its permissions (600) are preserved,
# and nothing echoes its contents.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

if [[ ! -f docker-compose.yml || ! -f CLAUDE.md ]]; then
  echo "error: $repo_root does not look like the Helpdesk Anywhere repo root" >&2
  exit 1
fi

backup_root="${HDA_MIGRATION_DIR:-$HOME/hda-migration}"
timestamp="$(date -u +%Y%m%d-%H%M%S)"

echo "→ project: $repo_root"
echo "→ backup root: $backup_root"

for d in config data audit generated artifacts claude-memory docker system manifests restore; do
  mkdir -p "$backup_root/$d"
done
# Re-running must not carry stale files from an earlier backup into this one.
rm -rf "$backup_root/data/"* "$backup_root/audit/"* "$backup_root/artifacts/"* "$backup_root/claude-memory/"* \
       "$backup_root/config/staging-gate"

# ---------------------------------------------------------------- config/
# .env is copied with its restrictive mode preserved. Never cat/echo it.
if [[ -f .env ]]; then
  install -m 600 .env "$backup_root/config/.env"
  echo "→ copied .env (permissions preserved, contents not shown)"
else
  echo "→ WARNING: .env not found — nothing to restore secrets from" >&2
fi
for f in .env.example Caddyfile docker-compose.yml docker-compose.local.yml docker-compose.caddy-local.yml; do
  [[ -f "$f" ]] && cp -f "$f" "$backup_root/config/$f"
done
# Staging (scripts/staging.sh): its generated secrets and the MT-10 public
# gate's password. Both are gitignored, so without this they exist nowhere else.
if [[ -f .env.staging ]]; then
  install -m 600 .env.staging "$backup_root/config/.env.staging"
  echo "→ copied .env.staging (permissions preserved, contents not shown)"
fi
if [[ -d .staging-gate ]]; then
  cp -a .staging-gate "$backup_root/config/staging-gate"
  echo "→ copied .staging-gate/ (permissions preserved, contents not shown)"
fi

# ---------------------------------------------------------------- audit/
# The only persistent application state (CLAUDE.md constraint #5). Session
# state itself is in-memory by design — nothing else to snapshot here.
if compgen -G "audit/*.jsonl" >/dev/null 2>&1; then
  cp -f audit/*.jsonl "$backup_root/audit/"
  echo "→ copied $(compgen -G "audit/*.jsonl" | wc -l) audit log file(s)"
else
  echo "→ no audit/*.jsonl files found"
fi
if compgen -G ".staging-audit/*.jsonl" >/dev/null 2>&1; then
  mkdir -p "$backup_root/audit/staging"
  cp -f .staging-audit/*.jsonl "$backup_root/audit/staging/"
  echo "→ copied $(compgen -G ".staging-audit/*.jsonl" | wc -l) staging audit log file(s)"
fi

# ---------------------------------------------------------------- generated/
# The built applet. Rebuilding is cheap (build-windows.sh) but it must be
# re-baked with the NEW host's URL regardless, so this copy is a reference/
# hash record, not something restore-new-vm.sh will serve as-is.
if compgen -G "server/public/download/*.exe" >/dev/null 2>&1; then
  cp -f server/public/download/*.exe "$backup_root/generated/"
fi
if compgen -G "server/public/download/*.ps1" >/dev/null 2>&1; then
  cp -f server/public/download/*.ps1 "$backup_root/generated/"
fi
if compgen -G "$backup_root/generated/*" >/dev/null 2>&1; then
  (cd "$backup_root/generated" && sha256sum * > SHA256SUMS.generated 2>/dev/null || true)
  echo "→ copied generated download artifacts"
fi

# ---------------------------------------------------------------- artifacts/
# ~/hda-artifacts holds the golden-checkpoint copies (GOLDEN_WORKING_STATE.md)
# and the slot for the real-Windows-verified .exe. A .NET single-file publish
# is not reproducible, so these can only be carried, never rebuilt.
artifacts_src="${HDA_ARTIFACTS_DIR:-$HOME/hda-artifacts}"
verified_status="NOT ARCHIVED"
if [[ -d "$artifacts_src" ]]; then
  cp -a "$artifacts_src/." "$backup_root/artifacts/"
  echo "→ copied $artifacts_src"
  if compgen -G "$artifacts_src/real-windows-verified/*.exe" >/dev/null 2>&1; then
    verified_status="archived: $(cd "$artifacts_src/real-windows-verified" && sha256sum ./*.exe | awk '{print $1}' | tr '\n' ' ')"
  fi
else
  echo "→ WARNING: $artifacts_src not found — golden artifacts not carried" >&2
fi
if [[ "$verified_status" == "NOT ARCHIVED" ]]; then
  echo "→ WARNING: the real-Windows-verified .exe (sha256 5ff97646…) is NOT on this VM." >&2
  echo "           Copy it from the Windows test machine before retiring this VM." >&2
fi

# ---------------------------------------------------------------- claude-memory/
# Claude Code's per-project memory (~/.claude/projects/<path-slug>/memory):
# project history, rules and lessons that are not in git. No secrets.
memory_src="$HOME/.claude/projects/$(printf '%s' "$repo_root" | sed 's/[^A-Za-z0-9]/-/g')/memory"
if [[ -d "$memory_src" ]]; then
  cp -a "$memory_src/." "$backup_root/claude-memory/"
  echo "→ copied Claude Code project memory ($(ls "$memory_src" | wc -l) files)"
fi

# ---------------------------------------------------------------- data/
# PostgreSQL (admin portal): a logical dump of every running Helpdesk Anywhere
# database — the live one once the admin portal is deployed, and staging's.
# pg_dump reads a consistent snapshot without stopping anything. The dump
# contains chat transcripts and notes, so it is written 600.
db_dumps=()
for container in helpdeskanywhere-db-1 hda-staging-db-1; do
  if [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" == "true" ]]; then
    name="${container%-db-1}"
    out="$backup_root/data/${name}.dump"
    ( umask 077; docker exec "$container" pg_dump -U helpdesk -d helpdesk -Fc > "$out" )
    # A dump pg_restore can't list is not a backup — fail now, not on the new VM.
    docker exec -i "$container" pg_restore -l < "$out" >/dev/null
    db_dumps+=("${name}.dump")
    echo "→ dumped $container → data/${name}.dump ($(du -h "$out" | cut -f1))"
  fi
done
cat > "$backup_root/data/README.txt" <<EOF
PostgreSQL logical dumps (pg_dump -Fc), one per running database at backup time:
  ${db_dumps[*]:-(none — no Helpdesk Anywhere database was running)}

helpdeskanywhere.dump — the live deployment (admin portal); loaded automatically
                        by restore-new-vm.sh when the restored commit has a db service
hda-staging.dump      — isolated staging; load with
                        ./scripts/cloud-migration/restore-database.sh backups/hda-staging.dump staging
                        then ./scripts/staging.sh up

The caddy_data/caddy_config volumes are only a TLS certificate cache and are not
carried — Caddy re-issues on the new host. Live remote-control session state is
in memory by design (CLAUDE.md constraint #4).
EOF

# ---------------------------------------------------------------- docker/
{
  echo "# docker ps -a"
  sudo docker ps -a 2>&1 || docker ps -a 2>&1
  echo
  echo "# docker images"
  sudo docker images 2>&1 || docker images 2>&1
  echo
  echo "# docker volume ls"
  sudo docker volume ls 2>&1 || docker volume ls 2>&1
  echo
  echo "# docker network ls"
  sudo docker network ls 2>&1 || docker network ls 2>&1
} > "$backup_root/docker/docker-state.txt"

# Redacted compose config (drop anything env-substituted from a secret key).
docker compose --profile tls config 2>/dev/null \
  | grep -viE 'password|token|authtoken|secret' \
  > "$backup_root/docker/compose-config.redacted.yml" || true

# ---------------------------------------------------------------- system/
{
  echo "# os-release"; cat /etc/os-release 2>/dev/null
  echo; echo "# hostname"; hostname
  echo; echo "# uname -a"; uname -a
  echo; echo "# disk"; df -h /
  echo; echo "# memory"; free -h
  echo; echo "# docker --version"; docker --version 2>&1
  echo; echo "# docker compose version"; docker compose version 2>&1
  echo; echo "# listening ports (best-effort)"; (sudo ss -tlnp 2>&1 || ss -tlnp 2>&1)
  echo; echo "# systemd services (docker/caddy/duckdns, best-effort)"
  systemctl list-units --type=service --all 2>/dev/null | grep -iE 'docker|caddy|duckdns' || echo "(none found)"
  echo; echo "# crontab -l (best-effort)"; crontab -l 2>&1 || true
} > "$backup_root/system/system-info.txt"

# ---------------------------------------------------------------- manifests/
git_sha="$(git rev-parse HEAD)"
git_branch="$(git rev-parse --abbrev-ref HEAD)"
# The commit the new VM should RUN is the one the live stack runs, which is not
# necessarily the checked-out development branch: until the admin portal is
# deployed (a live `db` container exists), live is `main`. restore-new-vm.sh
# reads "Commit SHA" below. Override with HDA_DEPLOY_REF=<ref>.
if [[ -n "${HDA_DEPLOY_REF:-}" ]]; then
  deploy_ref="$HDA_DEPLOY_REF"
elif [[ "$(docker inspect -f '{{.State.Running}}' helpdeskanywhere-db-1 2>/dev/null)" == "true" ]]; then
  deploy_ref="HEAD"
else
  deploy_ref="main"
fi
deploy_sha="$(git rev-parse "$deploy_ref^{commit}")"
if [[ -n "$(git branch -r --contains "$deploy_sha" 2>/dev/null)" ]]; then
  deploy_pushed="yes"
else
  deploy_pushed="NO — push it before migrating, or the new VM cannot check it out"
  echo "→ WARNING: deploy commit $deploy_sha is not on any remote branch" >&2
fi
git_remote="$(git remote get-url origin 2>/dev/null || echo "(none)")"
git_dirty="clean"
git diff --quiet --ignore-submodules HEAD -- || git_dirty="DIRTY — uncommitted changes present"
public_host_present="NOT FOUND"
[[ -f .env ]] && grep -qE '^PUBLIC_HOST=' .env && public_host_present="FOUND"

cat > "$backup_root/manifests/MIGRATION_MANIFEST.md" <<EOF
# Migration Manifest — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)

## Source VM
- OS: $(. /etc/os-release; echo "$PRETTY_NAME")
- Kernel: $(uname -r)
- Hostname: $(hostname)
- Project directory: $repo_root

## Git
- Repository: $git_remote
- Commit SHA: $deploy_sha
  (what the live stack runs — ref '$deploy_ref'; restore-new-vm.sh checks this out)
- Deploy commit pushed: $deploy_pushed
- Development branch: $git_branch
- Development branch SHA: $git_sha
- Working tree: $git_dirty

## Carried state
- PostgreSQL dumps: ${db_dumps[*]:-(none)}
- Staging config (.env.staging, .staging-gate/): $([[ -f .env.staging ]] && echo yes || echo no)
- Real-Windows-verified .exe (5ff97646…): $verified_status

## Docker
- Docker: $(docker --version 2>&1)
- Compose: $(docker compose version 2>&1 | head -1)
- Compose project: helpdeskanywhere
- Active profile observed at backup time: $(docker compose ps --status running --services 2>/dev/null | tr '\n' ',' | sed 's/,$//')

## Containers (expected)
- db         — postgres:16-alpine, internal only (admin-portal commits and later)
- app        — server/Dockerfile, 8080 console + 8081 admin (8081 on loopback only)
- caddy      — profile: tls   — publishes 80/443 (permanent DuckDNS path, PLAN 7.3)
- ngrok      — profile: ngrok — publishes 127.0.0.1:4040 only (temporary)
- cloudflared— profile: cloudflared — publishes 127.0.0.1:2000 only (temporary, no account/DNS)
Exactly one of caddy/ngrok/cloudflared should run at a time (one PUBLIC_HOST, one /ws Origin).

## Persistent volumes
- helpdeskanywhere_caddy_data, helpdeskanywhere_caddy_config — Let's Encrypt cert cache
  (tls profile only; safe to recreate empty on the new VM, Caddy re-issues automatically)
- ./audit (bind mount) — JSONL security log; back this up, do not skip it
- <project>_pgdata — PostgreSQL (admin portal: sessions, transcripts, notes, audit
  trail). Carried as a pg_dump in data/, never as a raw volume copy.

## Firewall / ports required
- 22/tcp  — SSH (administration)
- 80/tcp  — only for the tls profile (ACME HTTP-01 challenge + HSTS redirect)
- 443/tcp — only for the tls profile (HTTPS/WSS)
No inbound ports are required for the ngrok/cloudflared profiles — both dial out.

## Required environment variables (names only — see config/.env, restore manually)
$(sed -nE 's/^([A-Za-z_][A-Za-z0-9_]*)=.*/- \1/p' .env 2>/dev/null || echo "(.env not found)")

## Secrets present in .env (FOUND / NOT FOUND only)
- CONSOLE_PASSWORD: $(grep -qE '^CONSOLE_PASSWORD=.+' .env 2>/dev/null && echo FOUND || echo "NOT FOUND")
- NGROK_AUTHTOKEN:  $(grep -qE '^NGROK_AUTHTOKEN=.+' .env 2>/dev/null && echo FOUND || echo "NOT FOUND")
- PUBLIC_HOST set:  $public_host_present
- POSTGRES_PASSWORD / ENTRA_CLIENT_SECRET (needed from the admin-portal commit on):
  $(grep -qE '^POSTGRES_PASSWORD=.+' .env 2>/dev/null && echo FOUND || echo "NOT FOUND") / $(grep -qE '^ENTRA_CLIENT_SECRET=.+' .env 2>/dev/null && echo FOUND || echo "NOT FOUND")

## Domain / tunnel in use at backup time
See config/.env (PUBLIC_HOST) — not reproduced here as it identifies the live endpoint.
Cross-check against MIGRATION_DNS.md in the repo root for the cutover plan.

## systemd services required
None beyond docker.service itself. No DuckDNS renewal cron exists on this host
(Caddy's built-in ACME client handles renewal automatically when the tls profile
 is used — nothing to schedule separately).

## Required directories on the new VM
- <repo_root>/audit           (bind-mounted, must be writable by HOST_UID:HOST_GID)
- <repo_root>/server/public/download (applet .exe served from here)

## Application startup command
  cd <repo_root>
  export HOST_UID=\$(id -u) HOST_GID=\$(id -g)
  docker compose --profile <tls|ngrok|cloudflared> up -d --build

## Verification commands
  docker compose ps
  curl -fsS https://<host>/healthz
  ./scripts/verify-deployment.sh https://<host>
  ./scripts/cloud-migration/verify-migration.sh https://<host> $git_sha
EOF
echo "→ wrote manifests/MIGRATION_MANIFEST.md"

# ---------------------------------------------------------------- restore/
cat > "$backup_root/restore/README.txt" <<EOF
The restore script itself lives in the git repository (it is not duplicated
into this archive, so it can't drift from the code it restores):

  scripts/cloud-migration/restore-new-vm.sh

On the new VM: clone the repo at commit $git_sha, then run that script and
point it at this backup archive.
EOF

# ---------------------------------------------------------------- checksums
echo "→ computing checksums"
(
  cd "$backup_root"
  find config data audit generated artifacts claude-memory docker system manifests restore -type f \
    ! -name 'SHA256SUMS' -print0 | sort -z | xargs -0 sha256sum > manifests/SHA256SUMS
)

# ---------------------------------------------------------------- archive
archive="$HOME/hda-migration-${timestamp}.tar.gz"
( umask 077; tar czf "$archive" -C "$backup_root" config data audit generated artifacts claude-memory docker system manifests restore )
sha256sum "$archive" > "${archive}.sha256"

archive_size="$(du -h "$archive" | cut -f1)"
echo
echo "────────────────────────────────────────────────────────────────────────"
echo "  Backup complete"
echo "  Staged:  $backup_root"
echo "  Archive: $archive ($archive_size)"
echo "  SHA256:  ${archive}.sha256"
echo "  Secrets: not printed to this console; .env copied with 600 permissions"
echo "────────────────────────────────────────────────────────────────────────"
