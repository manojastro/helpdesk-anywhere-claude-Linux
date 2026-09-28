# Cloud Migration Runbook — Helpdesk Anywhere

Move this deployment from the current VM to a new one, on any Ubuntu 22.04/24.04
cloud VM, without breaking the working Windows remote-control functionality.

**Read first:** `MIGRATION_DNS.md` — the current deployment runs on a
temporary Cloudflare quick tunnel, not the DuckDNS hostname CLAUDE.md
describes as the permanent path. That changes what "DNS cutover" means here.
Decide Option A or B there before step 6 below.

The old VM is **never stopped by any of this**. Nothing here is destructive.

---

## 0. Prerequisites

- **The real-Windows-verified applet** (`HelpdeskAnywhere-REAL-WINDOWS-VERIFIED-2026-09-06.exe`,
  sha256 `5ff97646…`) exists only on the Windows test machine. It cannot be rebuilt
  (a .NET single-file publish is not reproducible). **Before step 1**, upload it to
  `~/hda-artifacts/real-windows-verified/inbox/` on the old VM and run
  `~/hda-artifacts/verify-and-archive-real-windows-binary.sh ~/hda-artifacts/real-windows-verified/inbox/<file>.exe`
  — it archives only an exact hash + size match and refuses the rebuild — so the
  archive carries it. The backup and restore both warn while it is missing.

- A new Ubuntu 22.04 or 24.04 LTS VM, any provider, with a public IP and SSH access.
- A way to copy one file (the migration archive, ~120MB) from the old VM to
  the new one: `scp`, `rsync`, or uploading through your cloud provider's
  console.
- If going with MIGRATION_DNS.md Option B: access to update the DuckDNS
  record (or your chosen DNS provider) for the domain you intend to use.

## 1. OLD VM — back up

```bash
cd "/home/ubuntu/Helpdesk Anywhere"
./scripts/cloud-migration/backup-current-vm.sh
```

This prints the archive path and its SHA256, e.g.:
```
Archive: /home/ubuntu/hda-migration-20260922-031332.tar.gz (58M)
SHA256:  /home/ubuntu/hda-migration-20260922-031332.tar.gz.sha256
```
It does not touch the running application. Nothing on the old VM is deleted.

What the archive carries (~120 MB):

| Item | Why it can't come from git |
|---|---|
| `.env`, `.env.staging` (mode 600) | Secrets — gitignored |
| `.staging-gate/` | MT-10 staging gate password |
| `audit/*.jsonl`, `.staging-audit/*.jsonl` | Security log (constraint #5) |
| `data/*.dump` | `pg_dump -Fc` of every running Helpdesk Anywhere database (live once the admin portal is deployed; staging now). Verified with `pg_restore -l` at backup time |
| `artifacts/` | `~/hda-artifacts`: golden-checkpoint copies + the real-Windows-verified slot |
| `generated/` | The current `.exe` (reference only — it dials the old host) |

The manifest records **two** commits: `Commit SHA` is what the live stack runs
(`main` until a live `db` container exists — override with `HDA_DEPLOY_REF=<ref>`),
and `Development branch` is the checked-out branch. The restore deploys the first.
The backup warns if that commit isn't pushed.

## 2. Move the archive to the new VM

From your local machine (adjust hosts/paths):

```bash
scp ubuntu@<OLD_VM_IP>:~/hda-migration-*.tar.gz .
scp ubuntu@<OLD_VM_IP>:~/hda-migration-*.tar.gz.sha256 .
scp hda-migration-*.tar.gz hda-migration-*.tar.gz.sha256 ubuntu@<NEW_VM_IP>:~
```

Or `rsync`/provider console upload — whatever's available. Verify the
checksum travelled correctly once it lands on the new VM:

```bash
cd ~ && sha256sum -c hda-migration-*.tar.gz.sha256
```

## 3. NEW VM — bootstrap

```bash
git clone https://github.com/manojastro/helpdesk-anywhere-claude-Linux.git
cd helpdesk-anywhere-claude-Linux
git checkout feature/admin-portal     # carries the current migration tools
./scripts/cloud-migration/bootstrap-new-vm.sh
```

Installs git/curl/ca-certificates/Docker Engine + Compose plugin, Node.js 22 and
Microsoft's .NET 8 SDK (into `~/.dotnet` — Ubuntu's apt SDK cannot build the
WinForms applet), enables Docker at boot, adds your user to the `docker` group.
Node and .NET are needed because step 7 rebuilds the applet on the new VM. Log out and back in
(or `newgrp docker`) if it added you to that group.

## 4. NEW VM — firewall

```bash
cd ~/helpdesk-anywhere-claude-Linux
./scripts/cloud-migration/configure-firewall.sh cloudflared   # or: tls
```

Also open the same ports (22, plus 80/443 only for the `tls` profile) in
your cloud provider's security group / firewall rules / security list —
`configure-firewall.sh` only configures UFW on the VM itself; the
provider-side perimeter firewall is a separate step in each provider's
console (see the script's own printed reminder).

## 5. NEW VM — restore and start (on a temporary tunnel — no DNS needed yet)

```bash
./scripts/cloud-migration/restore-new-vm.sh ~/hda-migration-*.tar.gz
```

This runs from a private copy of the migration tools (so checking out another
commit can't rewrite it mid-run), checks out the exact commit the old VM was
running, restores `.env` (backing up any existing one first — never silently
overwritten), `.env.staging` and `.staging-gate/` (only if absent), audit logs,
`~/hda-artifacts` (never replacing an existing file), the database dumps into
`backups/`, and the reference `.exe`. It adds those secret-bearing paths to
`.git/info/exclude`, since older commits don't gitignore them. It fixes ownership,
validates the compose config, **loads `backups/helpdeskanywhere.dump` into the
live database before the app's first start** (when there is one and the commit
has a `db` service), and **starts the stack on the `cloudflared` profile** — deliberately
the profile that needs no DNS change, so the new VM can be fully tested
independently of the old one before any cutover decision. It prints a fresh
temporary `https://...trycloudflare.com` URL and runs a health check.

Pass `--no-start` if you'd rather bring the stack up yourself.

**Staging** is not started automatically (it needs the admin-portal branch). The
restore prints the three commands; they are:

```bash
git checkout feature/admin-portal
./scripts/cloud-migration/restore-database.sh backups/hda-staging.dump staging
./scripts/staging.sh up
```

`restore-database.sh` starts only the `db` service, and refuses to load into a
database that already has tables — it never overwrites data.

**Deploying the admin portal to live** (rather than `main`) additionally needs
`POSTGRES_PASSWORD`, `ADMIN_PUBLIC_HOST` and the `ENTRA_*` values in `.env` — the
old VM's `.env` does not have them yet (the manifest reports FOUND / NOT FOUND).
See `docs/ADMIN_PORTAL.md`.

## 6. NEW VM — verify

```bash
./scripts/cloud-migration/verify-migration.sh https://<the-temp-url-from-step-5> <commit-sha>
```

Every line should read PASS or WARNING (never FAIL — WARNING is expected for
things like DNS resolution and TLS cert issuer when on the temporary tunnel).

## 7. Manual test pass

Work through `MIGRATION_TEST_PLAN.md` against the new VM's temporary URL,
including the Windows remote-control rows marked CRITICAL, with a real
Windows test machine. **This is a manual human step — nothing in this repo
can run-test Windows code (CLAUDE.md).** You will need to rebuild the
Windows applet against the new VM's URL first:

```bash
SERVER_URL="wss://<new-vm-temp-host>/ws" ./scripts/build-windows.sh
```

## 8. Decide: stay on a temp tunnel, or cut over to permanent DNS

See `MIGRATION_DNS.md` for the full decision and the exact DNS steps. Short
version:
- **Option A (fast):** you're already done — the new VM is live on its own
  temporary URL. Distribute the newly-built `.exe`. Skip to step 10.
- **Option B (permanent DuckDNS + Caddy):** continue to step 9.

## 9. NEW VM — cut over to the permanent hostname (Option B only)

```bash
# Point the DuckDNS (or other DNS) A record at the new VM's public IP first.
dig +short <name>.duckdns.org   # from a machine that is NEITHER VM — confirm it resolves to the NEW VM

./scripts/deploy.sh    # tls profile — this itself refuses to start if DNS doesn't resolve yet

./scripts/cloud-migration/verify-migration.sh https://<name>.duckdns.org <commit-sha>

SERVER_URL="wss://<name>.duckdns.org/ws" ./scripts/build-windows.sh
```

Re-run the CRITICAL rows of `MIGRATION_TEST_PLAN.md` once more against the
permanent hostname before retiring the old VM.

## 10. Retire the old VM

Only after every CRITICAL test in `MIGRATION_TEST_PLAN.md` passes on the new
VM. This is a manual, deliberate step outside the scope of this tooling —
this runbook does not stop or delete the old VM for you.

---

## Rollback

The old VM was never touched. If anything on the new VM doesn't check out,
simply keep serving from the old VM and re-run steps 3-9 after fixing the
issue — nothing here is one-way until you personally retire the old VM in
step 10.
