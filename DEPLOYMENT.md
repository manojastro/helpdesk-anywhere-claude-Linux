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

## 0. Prerequisites

On a fresh Ubuntu machine, in this order (`PLAN.md` Phase 0 is the authority):

```bash
sudo apt update && sudo apt install -y curl git build-essential
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
sudo apt install -y docker.io docker-compose-v2 && sudo usermod -aG docker "$USER"

# .NET from MICROSOFT, not apt: Ubuntu's dotnet-sdk-8.0 ships without
# Microsoft.NET.Sdk.WindowsDesktop, and every WinForms project fails to load.
curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
chmod +x /tmp/dotnet-install.sh && /tmp/dotnet-install.sh --channel 8.0 --install-dir "$HOME/.dotnet"
cat >> ~/.bashrc <<'EOF'
export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$HOME/.dotnet:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
EOF
```

Log out and back in for the docker group. Then verify all four:

```bash
node -v                                                   # v22.x
dotnet --version                                          # 8.x
docker ps                                                 # no permission error
ls "$DOTNET_ROOT"/sdk/*/Sdks/Microsoft.NET.Sdk.WindowsDesktop   # must exist
```

The server itself needs only Docker. The .NET SDK is needed to build the Windows
applet; without it the deploy scripts still bring the stack up and simply skip
the applet rebuild.

---

## 0b. Local, with no tunnel and no certificate

For development and for running the regression suite against a real container:

```bash
cp .env.example .env            # PUBLIC_HOST=127.0.0.1:8080 is right for this mode
./scripts/dev-local.sh up       # build + start, waits for the health check
./scripts/dev-local.sh status   # what is running, and /healthz
./scripts/dev-local.sh verify   # verify-deployment.sh + verify-audit.sh
./scripts/dev-local.sh logs     # follow the app log
./scripts/dev-local.sh down
```

**Loopback only, and deliberately so.** This mode is plain HTTP with
`TRUST_PROXY` on, which must never face the internet — `X-Forwarded-For` and
`X-Forwarded-Proto` are then trivially forged. Two things also will not work over
it, both on purpose: Chrome blocks the `.exe` download over plain HTTP, and
credential-mode elevation is hard-refused off TLS. Use a tunnel for anything
involving a real Windows machine.

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

Every other key in `.env.example` has a working default and is documented in
place. The ones worth knowing about:

| Variable | Default | |
|---|---|---|
| `JOIN_ATTEMPTS_PER_MINUTE` | 5 | Code-guessing cap, per IP. A six-digit code is only ~1e6 wide. |
| `CREATE_ATTEMPTS_PER_MINUTE` | 10 | Session creation, per IP. One per support call is the real rate. |
| `MAX_LIVE_SESSIONS` | 500 | Hard ceiling; new sessions are refused rather than absorbed. |
| `ELEVATION_ATTEMPTS_PER_SESSION` | 5 | Admin-credential attempts before the session is cut off. |
| `ALLOWED_ORIGINS` | empty | Only needed if the console is served from a *different* hostname than `PUBLIC_HOST`. |
| `ALLOW_INSECURE_DEV` | 0 | Local plain-HTTP development only. **The server refuses to start** if this is set on anything that looks like a real deployment. |

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

## 2a. ngrok bandwidth limit — `ERR_NGROK_725`

**Hit on 2026-09-05.** Every request to the tunnel returns HTTP 403 with:

> This ngrok account has reached its network bandwidth limit for the month.

The Ubuntu stack is unaffected — verify it directly and you will see it healthy:

```bash
APPIP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' helpdeskanywhere-app-1)
curl -s "http://$APPIP:8080/healthz"
./scripts/verify-deployment.sh "http://$APPIP:8080"     # 14/14; the 2 TLS checks need HTTPS
```

**Restarting the tunnel does not help.** The cap is monthly and account-wide, not
per-tunnel, so a new URL from the same authtoken is refused the same way.

This is not a small cap for this project. The applet is a **66 MB** download and
every screen frame of every session crosses the same tunnel, so a handful of test
downloads plus a few minutes of streaming is a meaningful fraction of a free-tier
month. Two verification downloads during one session contributed to hitting it.

Options:

1. **Move to §2b, DuckDNS + Caddy.** This is what `CLAUDE.md` specifies and what
   `DECISIONS.md` D-007 always described ngrok as a stopgap for. No bandwidth cap,
   a stable hostname, and the applet stops needing a rebuild every time the URL
   changes. Needs ports 80 and 443 reachable on the VM.
2. Wait for the monthly reset, or upgrade the ngrok plan.

Note that **nothing can be manually tested while this is in effect** — the applet
download and the session's WebSocket both go through the tunnel — so a pending
`MANUAL_TESTS.md` entry is blocked on it, not merely inconvenienced.

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
./scripts/verify-deployment.sh https://<your-host>   # HTTP/WS level, 16 checks
./scripts/verify-audit.sh                            # audit integrity + no credentials
docker compose --profile ngrok ps                    # health status
docker compose --profile ngrok logs -f app           # live logs
```

**The TLS path can be verified without DNS or a certificate authority:**

```bash
./scripts/verify-tls-local.sh    # 9 checks, brings the stack up and tears it down
```

**Do not run this against a live deployment.** It shares the `helpdeskanywhere`
compose project name, so its teardown removes the running `app` container and
leaves a stray `caddy` behind — a live ngrok tunnel starts answering 502. Restore
with `docker rm -f helpdeskanywhere-caddy-1 && docker compose --profile ngrok up -d`;
the tunnel URL itself survives, because the `ngrok` container is untouched.

It runs the **real** `caddy` service from the **real** `Caddyfile`, with
`PUBLIC_HOST=localhost` so Caddy signs a certificate from its own internal CA.
Everything else in the path is byte-identical to the permanent deployment:
TLS termination, the HTTP→HTTPS redirect, the HSTS header, the `/download` route
Caddy serves directly from `/srv/public`, the `/ws` upgrade through the proxy,
and the foreign-Origin refusal behind it. Only the certificate's issuer differs.

It does **not** prove ACME, DNS, or the cloud firewall — that is MT-05 and
`PLAN.md` 7.2/7.4, and those need a real hostname.

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

## 5b. Running a support session end to end

1. Open the console URL and authenticate (`CONSOLE_USER` / `CONSOLE_PASSWORD`).
2. **Start session** → a six-digit code and a join link,
   `https://<your-host>/j/<code>`.
3. Read the code, or send the link, to the person you are helping. Codes are
   single-use and expire after ten minutes.
4. They download the applet from that page, run it (SmartScreen → *More info* →
   *Run anyway* on an unsigned binary), and type the code.
5. Their machine shows a consent dialog naming you. **Nothing streams until they
   click Accept** — the relay drops any earlier frame.
6. Their screen appears on the console canvas. A red indicator is now pinned on
   their desktop, and one click on it ends the session from their side.
7. Optional — **Unlock UAC prompts**: *ask the user to approve* if they are a
   local administrator, or *enter admin credentials* if they are not. The console
   banner reads "UAC prompt active" whenever the secure desktop is up.
8. Optional — the script pane runs PowerShell or cmd, with output streaming as it
   is produced; **Run as SYSTEM** requires elevation first.
9. **End session** tears both sides down: capture stops, held keys and mouse
   buttons are released, any script the agent started is killed with its whole
   process tree, and the elevated service is uninstalled.
10. Confirm the record: `./scripts/verify-audit.sh`, or read
    `audit/audit-<date>.jsonl` directly.

---

## 7. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Container restart-loops, log says the audit directory is not writable | The bind-mounted `./audit` belongs to a different uid than the container user. Set `HOST_UID`/`HOST_GID` in `.env`, or use `scripts/dev-local.sh`, which does it for you. |
| `[server] FATAL: ALLOW_INSECURE_DEV is set on what looks like a real deployment` | Exactly what it says: that flag allows admin credentials over plaintext. Remove it from `.env` — it is for local plain-HTTP development only. |
| Console returns 401 forever | `CONSOLE_PASSWORD` in `.env` differs from what you are typing. The stack reads `.env` at start, so `down` and `up` again after changing it. |
| Applet says it cannot reach the server | The URL was baked at build time. Rebuild with `./scripts/build-windows.sh --server https://<host>`, or type the address into the applet's own field. An ngrok URL changes on every restart unless `NGROK_URL` reserves it. |
| Chrome refuses the download: "Insecure download blocked" | You are on plain HTTP. Use a tunnel or the TLS profile; this is Chrome's rule, not the app's. |
| The console's Elevate button reports `insecure_transport` | Credential-mode elevation is hard-refused off `wss:` (constraint #6.1). Same fix: real TLS. |
| `elevation_rate_limited` | Five attempts per session, by design. Start a new session; raise `ELEVATION_ATTEMPTS_PER_SESSION` only if you have a reason. |
| Ctrl+Alt+Del stays greyed out | It unlocks only after a successful elevation — no `SendInput` sequence can produce a Secure Attention Sequence, so an unelevated session has nothing to route it to. |
| Windows still lists `HelpdeskAnywhereSvc` after a session | Give it 60 s: the applet asks the service to remove itself, and the watchdog is the backstop. Force it with `HelpdeskAnywhere.exe --uninstall-service` from an elevated prompt, or `sc delete HelpdeskAnywhereSvc`. |
| `/ws` upgrade fails behind a proxy | The proxy is not forwarding the upgrade headers. `verify-deployment.sh` checks exactly this; compare against the shipped `Caddyfile`. |
| A session ends the moment it is created | Two consoles sharing one browser profile, or the server restarted — session state is in-process and does not survive a restart. |

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
- **The relay can see plaintext frames.** Documented in `shared/protocol.md`: past
  a POC, elevation payloads should be end-to-end encrypted to a key the applet
  generates at session start.
- **Nothing under `windows/` has been run on Windows yet.** It cross-compiles and
  is covered by source invariants and wire-level tests, which is not the same
  thing. `MANUAL_TESTS.md` MT-01…MT-06 are the acceptance tests.
- The runtime dependency surface is two packages, `express` and `ws`, pinned by
  `package-lock.json` and installed with `npm ci` in the image. `npm audit
  --omit=dev` reports **0 vulnerabilities** as of 2026-09-05. (An earlier note
  here said the registry was unreachable from this environment; it is reachable,
  and the check does run.)
- **The applet download is deliberately unauthenticated** — the end user has no
  credentials and must not need any. The binary is inert without a live
  six-digit code, and codes are single-use with a ten-minute TTL, but anyone who
  finds the URL can fetch it.
- **The applet is unsigned**, so SmartScreen shows "Windows protected your PC" and
  Defender may quarantine it. That detection is correct behaviour for an unsigned
  binary that injects input. Add a path exclusion on the test VM; for anything
  beyond a POC, get it code-signed (`PLAN.md` 7.6).
