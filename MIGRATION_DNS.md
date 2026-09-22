# Domain / DNS Migration

## What this deployment actually uses today

This is important and differs from what CLAUDE.md describes as the intended
*permanent* setup. There are **three interchangeable ways** to reach the
stack (`docker-compose.yml`, PLAN 7.1 / DECISIONS.md D-007) — `tls` (DuckDNS +
Caddy + Let's Encrypt), `ngrok`, and `cloudflared`. As of this backup:

- **The live deployment is running the `cloudflared` profile** — a Cloudflare
  *quick tunnel* with a random, unregistered `*.trycloudflare.com` hostname.
- **No DuckDNS hostname is currently active.** `.env.example` documents the
  intended permanent hostname pattern (`PUBLIC_HOST=helpdesk-anywhere.duckdns.org`),
  but no `DUCKDNS_TOKEN` is present on this VM and the `tls`/Caddy profile is
  not the one running.
- **ngrok is configured (`NGROK_AUTHTOKEN` present) but not currently running.**

Practically: there is **no DNS record pointing at this VM to migrate**. The
cloudflared tunnel's hostname is inherently tied to *this* VM's tunnel process
— it cannot be "moved" to a new VM; a fresh tunnel on the new VM gets a
different random hostname regardless of migration.

## What this means for the Windows client

`windows/Applet/AppletConfig.cs` bakes a server URL into the .exe at build
time (`scripts/build-windows.sh`, `SERVER_URL`/`PUBLIC_HOST`). Because the
current hostname is a random per-process cloudflared address:

- **The .exe already needs rebuilding on every tunnel restart**, independent
  of any VM migration — this is expected, documented behavior
  (`deploy-cloudflared.sh`'s own comments), not a migration-specific problem.
- The applet also has a manual server-address field (`AppletConfig.cs`), so a
  stale .exe can still be pointed at the new host by hand if needed.

## Recommended migration path

Given the above, this is a good opportunity to move onto the **intended
permanent path** (`tls` profile, DuckDNS + Caddy + Let's Encrypt) instead of
re-creating another disposable tunnel on the new VM — but that is a decision
for you to make, not something this tooling should do automatically.

### Option A — stay on a disposable tunnel (fastest, zero DNS work)
1. Deploy the new VM with `scripts/deploy-cloudflared.sh` (or `deploy-ngrok.sh`).
2. It gets its own new random hostname immediately — nothing to "cut over."
3. Rebuild/redistribute the .exe with the new URL once (already required
   routinely with this profile).
4. Retire the old VM once the new one is verified.

### Option B — move to the permanent DuckDNS + Caddy path (recommended)
Requires: a DuckDNS account and domain token (`DUCKDNS_TOKEN` — not currently
present in `.env`; you will need to obtain/generate one, or reuse one from
elsewhere if this project already has a registered subdomain outside this VM).

```
OLD VM (cloudflared, random hostname)
        ↓  stays running, unaffected
NEW VM deployed with the SAME temporary cloudflared profile first
        ↓  verify-migration.sh passes against the new VM's temp URL
Point the DuckDNS subdomain's A record at the NEW VM's public IP
        ↓  propagation (DuckDNS updates are near-instant, but allow a few minutes)
dig +short <name>.duckdns.org   # from OFF the new VM, confirm it resolves to the new IP
        ↓
./scripts/deploy.sh   on the NEW VM (tls profile — this also validates DNS
        before starting Caddy, and refuses if it doesn't resolve yet)
        ↓
Confirm Let's Encrypt issued a certificate (verify-migration.sh check #15)
        ↓
Rebuild the .exe once more, this time with the permanent DuckDNS URL:
   SERVER_URL="wss://<name>.duckdns.org/ws" ./scripts/build-windows.sh
        ↓
Run the full MIGRATION_TEST_PLAN.md against the NEW VM, permanent hostname
        ↓
Retire the OLD VM
```

### Cutover safety notes
- **Do not point DNS at the new VM until it has independently passed
  `verify-migration.sh` on its own temporary tunnel URL.** The old VM keeps
  serving traffic the entire time — nothing forces a hard cutover moment.
- DuckDNS propagation is fast (usually seconds to low minutes), but always
  verify `dig +short <host>` from a machine that is **not** either VM before
  starting Caddy — `scripts/deploy.sh` already refuses to start if it
  doesn't resolve, precisely to avoid a failed/rate-limited Let's Encrypt
  ACME challenge (CLAUDE.md, "Public URL and TLS").
- Only one tunnel profile should run at a time on the new VM — the deploy
  scripts already enforce this (`deploy-cloudflared.sh` stops `ngrok` if it
  finds it running; the same discipline applies to `caddy` vs the others).

## Windows client rebuild — required either way

**YES, the Windows applet must be rebuilt (or manually repointed) after this
migration**, regardless of which option above you choose, because:
- Option A: a fresh tunnel always gets a new hostname.
- Option B: even keeping the "same" DuckDNS name, the certificate and the
  underlying IP change, and any `.exe` built against the old cloudflared URL
  won't resolve to the new host either way.

This is not a regression introduced by migration — it is inherent to how
`SERVER_URL` is baked at build time (PLAN 2.2). Use
`scripts/build-windows.sh` on the new host (or any Linux dev box with the
.NET SDK) once the new VM's public URL is final.
