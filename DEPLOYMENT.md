# Helpdesk Anywhere — Deployment

Two ways to put this on the internet. They share one `app` service and one image,
so moving from the first to the second changes configuration only — **no
application code changes** (`DECISIONS.md` D-007).

| | `ngrok` profile | `tls` profile |
|---|---|---|
| Purpose | temporary, while there is no DNS | permanent |
| Hostname | ngrok-assigned or a reserved static domain | your DuckDNS subdomain |
| TLS | terminated at ngrok's edge | Caddy + Let's Encrypt, auto-renewed |
| Ports to open | none inbound | 80 and 443 |
| Command | `./scripts/deploy-ngrok.sh` | `./scripts/deploy.sh` |

Both give the browser real HTTPS, which matters: Chrome blocks executable
downloads served over plain HTTP, and credential-mode elevation (Phase 5) is
hard-refused on a non-`wss:` connection.

---

## 1. Configure

```bash
cp .env.example .env
```

Then edit `.env`. **`.env` is gitignored and must never be committed** — the
example file holds placeholders only.

At minimum:

| Variable | Why |
|---|---|
| `CONSOLE_PASSWORD` | The only thing between a public URL and a working remote-control console. `deploy-ngrok.sh` refuses to start without it. |
| `NGROK_AUTHTOKEN` | ngrok profile only. From <https://dashboard.ngrok.com> → "Your Authtoken". |
| `PUBLIC_HOST` | The hostname reported in the health check and the startup log. |
| `HOST_UID` / `HOST_GID` | The uid that owns `./audit`. The deploy scripts set these from `id -u`/`id -g`; only set them by hand if you run `docker compose` directly. |

`NGROK_URL` is optional and worth setting: reserve the free static domain on the
ngrok dashboard, and the URL survives a restart — otherwise ngrok assigns a new
one each time and the applet has to be rebuilt to match.

---

## 2. Deploy — ngrok (temporary)

```bash
./scripts/deploy-ngrok.sh
```

It builds the image, starts `app` and `ngrok`, waits for the tunnel, rebuilds the
Windows applet so the `.exe` dials **that** tunnel, runs the deployment
verification, and prints the three URLs you need.

No inbound firewall rules and no port forwarding: ngrok dials out, and so do both
clients.

## 2b. Deploy — DuckDNS + Caddy (permanent)

Do `PLAN.md` 7.2 first — create the subdomain, point it at this VM's public IP,
and confirm `dig +short <sub>.duckdns.org` returns the right address **from off
the VM**. Do not start Caddy before that resolves: a failing ACME HTTP-01
challenge gets rate-limited by Let's Encrypt.

```bash
# PUBLIC_HOST=<sub>.duckdns.org in .env
./scripts/deploy.sh
```

Open **only** 80 and 443, in the cloud security group *and* in `ufw`. On Oracle
Cloud the instance-level iptables are a separate, commonly-missed layer.

Migrating from ngrok is exactly this: change `PUBLIC_HOST`, run `deploy.sh`
instead, and rebuild the applet with the new `SERVER_URL`. Nothing in
`server/src` or `windows/` changes.

---

## 3. Build the Windows applet

```bash
SERVER_URL="wss://<your-host>/ws" ./scripts/build-windows.sh
```

The URL is compiled into the binary so the end user types nothing but the
six-digit code (`DECISIONS.md` D-004). The `.exe` lands in
`server/public/download/HelpdeskAnywhere.exe`, which is exactly where the app (and
Caddy, in `tls` mode) serves it from — the dev loop and the product flow are the
same path.

`deploy-ngrok.sh` does this for you when the .NET SDK is present.

---

## 4. Verify

```bash
./scripts/verify-deployment.sh https://<your-host>   # HTTP/WS level, 10 checks
./scripts/verify-audit.sh                            # audit integrity + no credentials
docker compose --profile ngrok ps                    # health status
docker compose --profile ngrok logs -f app           # live logs
```

`verify-deployment.sh` checks health, that the console demands credentials and
accepts the right ones, that the join page and the download stay open to a user
with no credentials, that the download really is a Windows binary, and — the one
that breaks most reverse-proxied deployments of this shape — that the `/ws`
upgrade completes end to end.

---

## 5. Operations

**Health.** `GET /healthz` returns `{ok, publicHost, uptimeSeconds, consoleAuth}`
and nothing an unauthenticated caller should not see. The container has a
`HEALTHCHECK`; `caddy` and `ngrok` both wait for `app` to be healthy before
starting.

**Restart.** Every service is `restart: unless-stopped`, so the stack survives a
crash and comes back after a reboot once Docker starts. Sessions do not survive —
session state is in-process by design, and the applet exits cleanly when the relay
drops. That is the correct failure mode for a consent-gated tool: nothing keeps
running unattended.

**Logs.** JSON-file driver capped at 10 MB × 5 per service, so a long-lived POC
cannot fill the disk.

**Audit.** Written to `./audit/audit-<date>.jsonl` on the host. The server
**refuses to start** if that directory is not writable — an unauditable support
tool is worse than none, and the failure used to be a single silent line on
stderr.

**Stop.** `docker compose --profile ngrok down` (or `--profile tls`).

---

## 6. Known limitations

- **ngrok URLs are ephemeral** unless you reserve the static domain. A new URL
  means rebuilding the applet, or having the end user type the address into the
  applet's own field.
- **The free ngrok tier shows an interstitial warning page** to browsers on first
  visit. It does not affect the applet's WebSocket or the `.exe` download, but the
  end user sees one extra click on the join page. The DuckDNS + Caddy path has no
  interstitial.
- **The console credential is a single shared password**, not user
  authentication — `PLAN.md` puts real login out of scope for the POC. There is no
  account, no lockout and no audit of *who* logged in, only that a session was
  created.
- **No Content-Security-Policy yet.** The join page carries an inline script;
  adding a policy needs a nonce, and a policy that silently breaks the one page a
  stressed end user must follow would be worse than none.
- **The relay can see plaintext frames.** Documented in `shared/protocol.md`: past
  a POC, elevation payloads should be end-to-end encrypted to a key the applet
  generates at session start.
- **The applet is unsigned**, so SmartScreen shows "Windows protected your PC" and
  Defender may quarantine it. That detection is correct behaviour for an unsigned
  binary that injects input. Add a path exclusion on the test VM; for anything
  beyond a POC, get it code-signed (`PLAN.md` 7.6).
