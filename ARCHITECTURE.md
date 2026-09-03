# Helpdesk Anywhere — Architecture (as implemented)

Describes what the code actually does today. `CLAUDE.md` holds the design intent and
the non-negotiable constraints; this file tracks the implementation and is updated
whenever it materially changes.

**Last updated:** 2026-09-03 (through Phase 7 deployment)

---

## Components

```
┌────────────────────────┐         ┌──────────────────────────────────┐
│  Agent console         │  WSS    │  Ubuntu VM (Docker + Caddy)      │
│  browser, any OS       │◄───────►│  https://<name>.duckdns.org      │
│  canvas render + input │  :443   │  Express + ws, TypeScript strict │
└────────────────────────┘         │  matchmaker · relay · file host  │
                                   │  Let's Encrypt via Caddy         │
┌────────────────────────┐  WSS    │                                  │
│  Windows applet (.exe) │◄───────►│                                  │
│  C# / .NET 8, WinForms │  :443   └──────────────────────────────────┘
└────────────────────────┘
```

Both endpoints **dial out**. The server never initiates a connection, so neither
side needs an inbound firewall rule or NAT traversal.

The Linux server is a **matchmaker, relay and file host only**. It never decodes
video, never injects input, and never sees a desktop. All capture, input injection,
elevation and script execution happen inside the Windows applet.

## Linux server — `server/`

| File | Responsibility |
|---|---|
| `src/index.ts` | Express app, `/healthz`, route mounting, HTTP+WS server |
| `src/config.ts` | Environment-variable configuration only; no config files |
| `src/protocol.ts` | TypeScript mirror of `shared/protocol.md` |
| `src/sessions.ts` | Session store, 6-digit code generation, TTL, per-IP join limiter |
| `src/signaling.ts` | WS upgrade, role handshake, consent gate, verbatim relay, teardown |
| `src/audit.ts` | Append-only JSONL audit log with credential redaction |
| `src/routes/portal.ts` | Agent console static assets + `/j/:code` join page |
| `src/routes/download.ts` | Serves `public/download/HelpdeskAnywhere.exe` |

No database. Session state is in-process and intentionally ephemeral: a restart ends
every live session, which is the correct failure mode for a consent-gated tool.
The audit log is the only durable state.

## Windows applet — `windows/Applet/`

| File | Responsibility |
|---|---|
| `Program.cs` | Entry point, global teardown hooks, arg parsing |
| `AppletContext.cs` | The flow: code entry → consent → indicator → teardown |
| `AppletConfig.cs` | Baked-in server URL, URL normalisation, code validation |
| `SessionClient.cs` | `ClientWebSocket` transport, dispatch loop, dual send queues |
| `Forms/CodeEntryForm.cs` | Server address + 6-digit code entry, retryable errors |
| `Forms/ConsentForm.cs` | Consent modal — constraint #1 |
| `Forms/IndicatorForm.cs` | Always-on-top session indicator — constraints #2, #3 |

`windows/Shared/` holds `Protocol.cs` (C# mirror) and `PipeChannel.cs` (Phase 5 IPC).
`windows/SecureDesktopService/` and `windows/DesktopHelper/` are Phase 5 scaffolds.

Published as a single self-contained `win-x64` .exe — no runtime install, no unzip,
no persistence. Cross-compiled from Ubuntu with `EnableWindowsTargeting=true`.

## Session lifecycle

```
waiting_for_host --host.join--> waiting_for_consent --host.consent{true}--> active
       |                              |                                       |
       +--- code TTL (10 min) ---> ended <--- host.consent{false} ------------+
                                     ^                                        |
                                     +---- agent.end / either peer drops ------+
```

Codes are 6 digits, single-use (burned on join), TTL 10 minutes. A refused join does
**not** close the socket — the user retypes on the same connection; guessing is
capped by a per-IP limiter (5/min) checked *before* the code lookup so response
timing cannot distinguish a real code from a fake one.

## Communication flow

- One WSS endpoint, `/ws`. First message declares the role (`agent.create` or
  `host.join`); anything else closes the socket.
- Control messages are JSON text frames with a `t` discriminator.
- Video is binary: `[0x01][jpeg]` full frame, `[0x02][x][y][w][h][jpeg]` dirty rect,
  big-endian. The same framing is reused over the Phase 5 named pipe so the applet
  can forward helper frames without re-encoding.
- The relay forwards frames **verbatim** — never re-serialised, buffered or logged.

## Trust boundaries and security

1. **Consent gates everything.** The relay drops any frame arriving before
   `state === "active"`, so no byte can reach the agent before Accept.
2. **The user always knows and can always stop it** — always-on-top indicator, one
   click to end, no option to suppress it.
3. **No persistence.** One-shot process; the Phase 5 elevated service is installed at
   session start and removed at session end; nothing survives reboot.
4. **The relay is trusted with plaintext** (POC limitation, documented in
   `shared/protocol.md`): past a POC the elevation payload should be end-to-end
   encrypted to a key the applet generates at session start.
5. **Credentials never touch disk.** Credential-mode elevation is hard-refused over
   non-`wss:`, rate-limited to 5 per session, audited by fact/mode/username only, and
   never logged or buffered.
6. **The download is served from the VM over TLS** by Caddy — never a public S3
   bucket. A permanently public unsigned remote-control binary is directly useful to
   tech-support scammers.

## Ports and protocols

| Port | Who | What |
|---|---|---|
| 443 | public | Caddy — HTTPS portal, join page, .exe download, WSS relay |
| 80 | public | Caddy — ACME HTTP-01 challenge + redirect to 443 |
| 8080 | internal | Node server; Caddy reverse-proxies to it |

Behind Caddy the client IP and TLS status come from `X-Forwarded-For` /
`X-Forwarded-Proto`, trusted only when `TRUST_PROXY=1` (set in `docker-compose.yml`,
off by default because those headers are forgeable with nothing in front).

## Authentication

There is **no user authentication** — real login is out of scope in `PLAN.md`, and
the consent dialog names a configured `AGENT_NAME` rather than a signed-in identity.

What does exist (Phase 7, `DECISIONS.md` D-008) is a single shared credential
protecting the console, enforced in the app so it covers both deployment modes:

- `CONSOLE_PASSWORD` unset → the console is open, and the server says so loudly at
  startup. Fine locally, unsafe on a public address.
- Set → HTTP Basic on the console page; on success the app issues an HttpOnly
  cookie, and `agent.create` is refused on any WebSocket that does not carry it.
  Gating the page but not the socket would be half a lock: the socket is what
  creates session codes.
- `/j/*`, `/download/*` and `/healthz` are always open — the end user has no
  credentials and must not need any.

## Deployment

Two interchangeable topologies over one identical `app` service and image, so
migrating between them is configuration only (`DECISIONS.md` D-007):

```
ngrok profile (temporary, no DNS)      tls profile (permanent)
  browser/applet                         browser/applet
        │ https/wss                            │ https/wss :443
   ngrok edge (TLS)                        Caddy (TLS, Let's Encrypt)
        │ http/ws                               │ http/ws
     app:8080  ──►  ./audit                  app:8080  ──►  ./audit
```

- `./scripts/deploy-ngrok.sh` — builds, starts, waits for the tunnel, rebuilds the
  applet against that URL, then verifies.
- `./scripts/deploy.sh` — the DuckDNS + Caddy path; refuses to start before the
  hostname resolves, because a failing ACME challenge gets rate-limited.
- `./scripts/verify-deployment.sh` — health, console auth, the end-user routes, the
  binary itself, and the `/ws` upgrade through the proxy.
- `./scripts/verify-audit.sh` — audit integrity plus the constraint #6 check that no
  credential ever reached a log.

The app runs as `${HOST_UID}:${HOST_GID}` so it can write the bind-mounted audit
directory, and **refuses to start** if it cannot: an unauditable support tool is
worse than none. Logs are capped at 10 MB × 5 per service. Everything is
`restart: unless-stopped`, and Docker is enabled at boot, so the stack returns after
a reboot — sessions deliberately do not.

See `DEPLOYMENT.md` for the operator's guide.
