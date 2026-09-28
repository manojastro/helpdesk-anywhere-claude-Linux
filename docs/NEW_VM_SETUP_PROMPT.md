# New VM setup — prompt for Claude Code

Paste everything inside the box below into Claude Code on the **new** VM. It
rebuilds the same setup as the old VM: same repo path, same branches, same
secrets, same database and audit data, same golden artifacts, same Claude
project memory, and a working toolchain that can rebuild the Windows applet.

**Before you paste it**, on the new VM:

1. Ubuntu 22.04 or 24.04 x86_64, logged in as a normal user with `sudo` (not root).
2. The migration archive and its checksum are in your home directory:
   `~/hda-migration-<timestamp>.tar.gz` and `~/hda-migration-<timestamp>.tar.gz.sha256`
   (made on the old VM with `./scripts/cloud-migration/backup-current-vm.sh`).
3. Claude Code is installed and started from your home directory.

The old VM keeps running throughout. Nothing in this prompt touches it.

---

```text
You are setting up a NEW Ubuntu VM as an exact working copy of the Helpdesk
Anywhere development and deployment VM. The old VM keeps running; do not try to
reach or change it. Work through the phases below in order. After each phase,
report in one or two lines what happened, then continue without waiting unless a
step says STOP. If any command fails, stop and show me the exact error — do not
work around a failure by skipping a step, disabling a check, or editing
application code.

Facts you need:
- Repo: https://github.com/manojastro/helpdesk-anywhere-claude-Linux.git
- Clone it to EXACTLY:  "$HOME/Helpdesk Anywhere"  (with the space). This keeps
  the Docker Compose project name "helpdeskanywhere" and the Claude memory path
  identical to the old VM; the backup script and the docs rely on both.
- Branches: `main` = what the live deployment runs. `feature/admin-portal` =
  current development AND the current migration tools. Tag
  `hda-windows-privileged-control-working-2026-09-06` and branch
  `golden/windows-privileged-control-2026-09-06` are the known-good Windows
  checkpoint — never modify or delete them.
- The migration archive is ~/hda-migration-*.tar.gz (use the newest if several).
- Never print, cat, or echo .env, .env.staging, .staging-gate/password or any
  secret. Report only FOUND / NOT FOUND for secrets.
- Never run `pkill node` / `killall node`; stop things by PID, port or container.
- Never force-push. Never commit .env files, backups/, or database dumps.

PHASE 1 — Verify inputs
1. `cd ~ && ls -la hda-migration-*.tar.gz*` and `sha256sum -c` the newest
   archive's .sha256 file. It must print OK. If not: STOP.
2. Confirm OS (`. /etc/os-release; echo $PRETTY_NAME`), `uname -m` = x86_64,
   free disk ≥ 15 GB (`df -h ~`), and that I am not root.

PHASE 2 — Clone and bootstrap
1. `git clone https://github.com/manojastro/helpdesk-anywhere-claude-Linux.git "$HOME/Helpdesk Anywhere"`
   (if it already exists, `git fetch --all --tags` instead of recloning).
2. `cd "$HOME/Helpdesk Anywhere" && git checkout feature/admin-portal`
3. `./scripts/cloud-migration/bootstrap-new-vm.sh`
   It installs git, curl, libicu, Docker Engine + Compose, Node.js 22 and
   Microsoft's .NET 8 SDK into ~/.dotnet (Ubuntu's apt dotnet CANNOT build the
   WinForms applet — never install it).
4. If it added me to the docker group, docker needs a new login shell. Run the
   remaining docker commands via `sg docker -c '...'`, or ask me to reconnect and
   restart you, then continue from PHASE 3.
5. Verify: `docker version`, `docker compose version`, `node -v` (v22.x),
   `$HOME/.dotnet/dotnet --version` (8.0.x), and
   `ls $HOME/.dotnet/sdk/*/Sdks/Microsoft.NET.Sdk.WindowsDesktop` exists.
   For every later shell command that needs dotnet, export
   `DOTNET_ROOT=$HOME/.dotnet PATH=$HOME/.dotnet:$PATH` explicitly —
   non-interactive shells may not read ~/.bashrc.

PHASE 3 — Firewall
1. `./scripts/cloud-migration/configure-firewall.sh cloudflared`
   (only SSH inbound is needed; the tunnel dials out).
2. Tell me to check my cloud provider's security group allows SSH (22) only —
   that part is outside the VM and I must do it myself.

PHASE 4 — Restore and start
1. From "$HOME/Helpdesk Anywhere":
   `./scripts/cloud-migration/restore-new-vm.sh ~/hda-migration-<newest>.tar.gz`
   It verifies the checksum, checks out the commit the old VM's live stack runs
   (detached HEAD — expected), restores .env, .env.staging, .staging-gate/,
   audit logs, ~/hda-artifacts, Claude project memory and the database dumps
   (into backups/), loads the live database dump if there is one, and starts
   the stack on a temporary Cloudflare quick tunnel. It prints a new
   https://<random>.trycloudflare.com URL — record it as NEW_URL.
   It never overwrites existing data; it is safe to re-run.
2. If it fails on compose validation, report which variable is missing — do not
   invent values. If it fails on CONSOLE_PASSWORD, tell me; I set it.
3. `docker compose ps` — every service should be running/healthy.

PHASE 5 — Verify the deployment
1. `./scripts/cloud-migration/verify-migration.sh <NEW_URL> $(git rev-parse HEAD)`
   Every line must be PASS or WARNING (WARNINGs about DNS / cert issuer are
   expected on a quick tunnel). Any FAIL: STOP and report.
2. `curl -fsS <NEW_URL>/healthz`
3. Confirm the audit logs arrived: `ls audit/*.jsonl | wc -l` (old VM had 9+).
4. Confirm golden artifacts: `ls -la ~/hda-artifacts` and check
   `~/hda-artifacts/real-windows-verified/` for
   HelpdeskAnywhere-REAL-WINDOWS-VERIFIED-2026-09-06.exe. Its sha256 must be
   5ff9764663e2016b91fc46ea036939ea8c842af049bc53b8f246536d02a48a40. If it is
   missing, tell me clearly — it cannot be rebuilt and must be copied from my
   Windows test machine. Never offer a rebuilt .exe as a substitute for it.

PHASE 6 — Rebuild the Windows applet for the new URL
The old .exe has the old VM's URL baked in and will not connect here.
1. `DOTNET_ROOT=$HOME/.dotnet PATH=$HOME/.dotnet:$PATH ./scripts/build-windows.sh --server <NEW_URL>`
   It cross-compiles, validates the embedded manifest, and writes
   server/public/download/HelpdeskAnywhere.exe. Report its sha256.
2. `curl -fsSI <NEW_URL>/download/HelpdeskAnywhere.exe` → HTTP 200.
3. This proves it COMPILES, not that it works. Windows code cannot be run-tested
   on Linux (see CLAUDE.md "Hard environment boundary").

PHASE 7 — Development environment
1. `git checkout feature/admin-portal` (the restore left a detached HEAD on the
   live commit; the running containers are unaffected by switching branches).
2. `cd server && npm ci && npm run build && cd ..`
3. Staging, if backups/hda-staging.dump exists:
   `./scripts/cloud-migration/restore-database.sh backups/hda-staging.dump staging`
   then `./scripts/staging.sh up`. It must print the console on :18080 and the
   admin portal on :18081, healthy.
4. `./tests/setup-browser.sh` (headless Chrome for the browser suites, cached
   outside the repo), then run the test suite: `./scripts/run-tests.sh`. The
   suite starts its own throwaway PostgreSQL container `hda-test-pg` on
   127.0.0.1:55432 (tests/README.md). Report the pass/fail counts. Do not "fix"
   failures by editing tests.
5. GitHub push access is NOT carried (tokens never travel). Tell me to run
   `! gh auth login` myself, then verify with `git push --dry-run origin feature/admin-portal`.

PHASE 8 — Claude context
1. Read CLAUDE.md, GOLDEN_WORKING_STATE.md, and the restored memory index at
   ~/.claude/projects/-home-ubuntu-Helpdesk-Anywhere/memory/MEMORY.md (the
   directory name follows the repo path; if my username is not "ubuntu" the
   directory name differs — find it under ~/.claude/projects/). Follow them from
   now on, especially: privileged Windows control is golden — diff against the
   golden tag before touching it; PLAN.md and CLAUDE.md are not edited; findings
   go in DEV_NOTES.md.
2. Add a memory note that this VM is now the working VM, with today's date and
   NEW_URL.

FINAL REPORT
Give me a checklist with PASS / FAIL / NEEDS YOU for: archive checksum,
toolchain, firewall, restore, verify-migration, audit logs, golden artifacts,
real-Windows-verified .exe, applet rebuild, staging, test suite, GitHub auth,
Claude memory. Then list what only I can do:
- cloud security group (SSH only for the tunnel profile);
- `gh auth login`;
- copy the real-Windows-verified .exe if it was missing;
- download the NEW .exe from NEW_URL on the Windows test machine and run the
  CRITICAL rows of MIGRATION_TEST_PLAN.md (UAC / Secure Desktop / elevated
  input) — a manual step on real Windows;
- decide whether to stay on the quick tunnel or move to DuckDNS
  (MIGRATION_DNS.md), and when to retire the old VM.
```

---

Background on each step: `CLOUD_MIGRATION_RUNBOOK.md`. What the archive carries:
runbook step 1.
