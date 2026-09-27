# Operating Helpdesk Anywhere (admin-portal release)

One container image, two applications, one database:

```
             app.example.org :443                     admin.example.org :443
                    │                                           │
              ┌─────┴───────────────── Caddy ──────────────────┴─────┐
              │ TLS for both names (Let's Encrypt), HSTS             │
              └─────┬──────────────────────────────────────────┬─────┘
                    │ app:8080                                  │ app:8081
        ┌───────────┴──────────── app container ────────────────┴───────────┐
        │ AGENT application              │ ADMIN application                 │
        │  technician console  /         │  admin portal  /  (admin-portal/) │
        │  customer join page  /j/<code> │  /api/admin/*                     │
        │  applet download     /download │  own sign-in, own cookie          │
        │  relay WebSocket     /ws       │  no WebSocket, no customer pages  │
        │  /api/agent/*, own sign-in     │                                   │
        │            shared: live-session state, code, PostgreSQL            │
        └──────────────────────────────┬─────────────────────────────────────┘
                                       │ db:5432 (internal network only)
                                ┌──────┴──────┐
                                │ PostgreSQL  │  volume `pgdata`
                                └─────────────┘
```

## 1. DNS and hostnames

Two names, same VM IP. With DuckDNS (free) create two subdomains, e.g.
`hda-app` and `hda-admin`, both pointing at the VM's public IP:

```
PUBLIC_HOST=hda-app.duckdns.org
ADMIN_PUBLIC_HOST=hda-admin.duckdns.org
```

With your own domain: two `A` records (`app` and `admin`) to the VM IP. Ports
**80** (ACME HTTP-01) and **443** must be open; nothing else is published.

## 2. Deploy and migrate on the Ubuntu VM

Prerequisites: Docker + compose plugin, the repo checked out, Entra configured
(`docs/ENTRA_SETUP.md`).

```bash
cd ~/"Helpdesk Anywhere"                 # or wherever the repo lives
git fetch origin
git checkout feature/admin-portal        # or main, once merged
git pull

cp -n .env.example .env                  # first time only; then edit it
chmod 600 .env
#   PUBLIC_HOST, ADMIN_PUBLIC_HOST, POSTGRES_PASSWORD (openssl rand -hex 24),
#   ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET, BOOTSTRAP_ADMIN_OIDS,
#   retention settings. Remove any old CONSOLE_PASSWORD / AGENT_NAME lines.

# The applet has the console URL baked in (DECISIONS.md D-004): rebuild it
# whenever PUBLIC_HOST changes.
./scripts/build-windows.sh

export HOST_UID=$(id -u) HOST_GID=$(id -g)
docker compose --profile tls build
docker compose --profile tls up -d db
docker compose --profile tls run --rm app node dist/db/migrate.js   # explicit migration
docker compose --profile tls up -d
docker compose --profile tls ps

./scripts/verify-deployment.sh "https://$PUBLIC_HOST" "https://$ADMIN_PUBLIC_HOST"
```

`scripts/deploy.sh` wraps the same steps (it refuses to run while the Entra or
database settings are placeholders).

Migrations also run automatically at startup (`DB_MIGRATE_ON_START=1`, under a
PostgreSQL advisory lock); the explicit command above lets you see the result
before the new version takes traffic. Migrations are forward-only: to roll back,
restore the pre-upgrade backup (section 5) and check out the previous tag.

**Upgrading the currently running deployment** (the one on the Cloudflare
tunnel): `docker compose ... up -d` *replaces* the running `app` container.
The new version refuses to start until `POSTGRES_PASSWORD`, the `ENTRA_*`
values and `ADMIN_PUBLIC_HOST` are set — plan the switch-over, do not run it
casually.

### First sign-in

1. `https://$ADMIN_PUBLIC_HOST` → Sign in with Microsoft as the bootstrap admin.
2. Create teams (Agents & access → Teams).
3. Technicians sign in at `https://$PUBLIC_HOST`, appear as Pending; activate them.
4. Clear `BOOTSTRAP_ADMIN_OIDS` in `.env`; `docker compose --profile tls up -d app`.

## 3. Separate subdomains: cookies, CSRF, WebSocket origin

| Concern | How it is handled |
|---|---|
| **Cookies** | Each application sets its own host-only cookie, `__Host-hda_agent` on `app.` and `__Host-hda_admin` on `admin.` (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`). A `__Host-` cookie cannot be scoped to the parent domain, so neither host ever receives the other's cookie. Server-side, each session row records its portal; a console session is not accepted by the admin application even if replayed under the other name. |
| **CSRF** | `app.` and `admin.` are the *same site*, so `SameSite=Lax` does **not** stop a request from one to the other. Every state-changing request therefore also needs the per-session `X-CSRF-Token` header, and a browser `Origin` that matches that application's own host. |
| **CSP** | Both apps send `connect-src 'self'`: the console page cannot call the admin API (or vice versa) even from script. `frame-ancestors 'none'` on both. |
| **WebSocket** | Only the agent application has `/ws`. A browser upgrade must come from the console's own origin **and** carry a valid console session (else 401); any other `Origin`, including `https://admin.…`, gets 403. The applet sends no `Origin` and is anonymous — it can only join as a customer. |
| **HSTS** | Caddy sends `Strict-Transport-Security` on both names. |
| **Proxy trust** | `TRUST_PROXY=1` (set by compose) makes the app use Caddy's `X-Forwarded-For`/`-Proto`. Never publish port 8080/8081 to the internet directly. |
| **Admin exposure** | Optional: restrict `admin.` by IP in the `Caddyfile` (commented example), and/or an Entra Conditional Access policy (MFA). |

## 4. Admin portal without DNS (temporary tunnel profiles)

The `cloudflared`/`ngrok` profiles expose only the agent application. The admin
portal is bound to the VM's loopback (`127.0.0.1:${ADMIN_LOCAL_PORT:-8081}`),
so reach it through SSH:

```bash
ssh -L 8081:127.0.0.1:8081 ubuntu@<vm>
# then browse http://localhost:8081
```

For Entra sign-in in that mode set `ADMIN_PUBLIC_HOST=localhost:8081` and
`OIDC_REDIRECT_URI_ADMIN=http://localhost:8081/auth/callback`, and register that
URI (Entra allows `http://localhost` redirect URIs). Browsers treat
`http://localhost` as a secure context, so the `Secure` cookie still works.

## 5. Backup and restore

What to back up:

| Item | Where | Notes |
|---|---|---|
| PostgreSQL | `pgdata` volume | Sessions, timelines, **chat transcripts and notes**, people, audit trail |
| JSONL security log | `./audit/` | Session lifecycle, elevation attempts, full script text |
| `.env` | repo root | Secrets — store separately (password manager / secret store) |
| Caddy certificates | `caddy_data` volume | Optional; Caddy re-issues them |

Nightly logical backup (keep it off the VM, and encrypted — it contains customer
conversations):

```bash
mkdir -p backups
docker compose exec -T db pg_dump -U helpdesk -d helpdesk -Fc \
  > "backups/helpdesk-$(date +%F).dump"
tar czf "backups/audit-$(date +%F).tgz" audit/
# cron (crontab -e):
# 15 2 * * * cd "/home/ubuntu/Helpdesk Anywhere" && docker compose exec -T db pg_dump -U helpdesk -d helpdesk -Fc > backups/helpdesk-$(date +\%F).dump
```

Restore:

```bash
docker compose --profile tls stop app
docker compose exec -T db pg_restore -U helpdesk -d helpdesk --clean --if-exists \
  < backups/helpdesk-YYYY-MM-DD.dump
docker compose --profile tls start app     # sessions left "live" in the dump are reconciled as server_restart
```

Retention applies to the live database only. Old backups still hold data past
`TRANSCRIPT_RETENTION_DAYS`; rotate them to match (e.g. keep 30 daily dumps).

## 6. Retention settings

| Variable | Default | Effect |
|---|---|---|
| `TRANSCRIPT_RETENTION_DAYS` | 365 | Chat and notes deleted this long after a session ends; the session shows "deleted by retention policy" |
| `SESSION_RETENTION_DAYS` | 730 | Whole session records and timelines deleted |
| `AUDIT_RETENTION_DAYS` | 0 (forever) | Administrative audit rows |
| `REPORT_TTL_MINUTES` | 15 | Generated PDF/CSV downloadable for this long, then erased |

The sweep runs at startup and hourly, and writes a `retention.purged` audit row
(counts only). Current values are shown in the admin portal under **Settings**.
`0` disables a rule.

## 7. Health and monitoring

* `https://app…/healthz` and `https://admin…/healthz` — `503` when the database
  is unreachable.
* Admin portal → Overview shows a red banner when session-record writes failed
  since start, and counts records marked incomplete.
* `docker compose logs -f app` — record-write failures are logged as
  `[records] write failed for session <uuid> (<what>)`, never with content.

## 8. Local testing without DNS or Entra

```bash
./scripts/dev-portals.sh          # console http://localhost:8080, admin http://localhost:8081
```

Uses the development sign-in form (`AUTH_MODE=dev`) and a throwaway PostgreSQL
container `hda-dev-pg`. First admin: object ID
`aaaaaaaa-0000-4000-8000-000000000001` with the Admin role. Remove the database
with `./scripts/dev-portals.sh stop-db`.

Full regression suite (starts its own PostgreSQL container `hda-test-pg`):

```bash
./scripts/run-tests.sh            # or --only ws|api|source|dotnet|browser
```

`scripts/dev-local.sh` (the compose stack on loopback) now runs the production
image, which requires real Entra settings; use `dev-portals.sh` for day-to-day
work.
