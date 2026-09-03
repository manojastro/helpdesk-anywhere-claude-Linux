# Helpdesk Anywhere

A LogMeIn Rescue-style attended remote-support tool, built as a proof of concept.

A support agent opens a browser console and generates a six-digit code. The end
user downloads a small Windows applet, runs it, types the code, and approves a
consent prompt. The agent then sees and controls that machine, and can run remote
scripts.

```
┌────────────────────────┐         ┌──────────────────────────────────┐
│  Agent console         │  WSS    │  Ubuntu VM (Docker)              │
│  browser, any OS       │◄───────►│  matchmaker · relay · file host  │
│  canvas + input        │         │  TLS via Caddy, or an ngrok edge │
└────────────────────────┘         │                                  │
┌────────────────────────┐  WSS    │                                  │
│  Windows applet (.exe) │◄───────►│                                  │
│  capture · input · exec│         └──────────────────────────────────┘
└────────────────────────┘
```

Both endpoints dial **out**, so neither needs an inbound firewall rule. The Linux
server never decodes video and never touches a desktop: all capture, input
injection and script execution happen inside the Windows applet.

## What makes this a support tool and not spyware

These are non-negotiable and must not be made configurable-off:

1. **Explicit consent before every session**, in a modal naming the requesting
   agent. Nothing streams before Accept — the relay itself drops any frame sent
   earlier.
2. **An always-visible session indicator** the user cannot hide.
3. **The user can end the session at any time**, in one click, from that indicator.
4. **No stealth, no hidden install, no persistence.** The applet is a one-shot
   process; nothing survives a reboot.
5. **An audit log** of session start/stop, consent decisions, elevation attempts
   and every executed script — and the server refuses to start if it cannot write
   it.
6. **Credentials are never logged or retained**, and admin credentials are refused
   outright over a non-TLS connection.

## Status

| Phase | | Status |
|---|---|---|
| 0 | Environment + scaffold | ✅ complete |
| 1 | Server: sessions, pairing, portal | ✅ complete |
| 2 | Applet: connect, code entry, consent | 🟡 built + Linux-verified; Windows test pending |
| 3 | Screen capture + streaming | 🟡 built + Linux-verified; Windows test pending |
| 4 | Remote mouse + keyboard | 🟡 built + Linux-verified; Windows test pending |
| 5 | UAC / Secure Desktop | ⚪ stretch goal, not started |
| 6 | Remote script execution | 🟡 built + Linux-verified; Windows test pending |
| 7 | Package, deploy, external access | 🟡 runs in Docker; external access pending a token |

Windows code cross-compiles on Linux but cannot be *run* there, so anything that
touches a real desktop is tracked in `MANUAL_TESTS.md` and is never marked passed
without an actual Windows run. `PROGRESS.md` is the authoritative state.

## Quick start

```bash
cp .env.example .env          # set CONSOLE_PASSWORD, and NGROK_AUTHTOKEN if using ngrok
./scripts/deploy-ngrok.sh     # public HTTPS URL in about a minute, no DNS needed
```

Then open the console URL it prints, create a session, and send the join link to
the Windows machine. `DEPLOYMENT.md` covers both deployment paths in full.

Local development without Docker:

```bash
./scripts/dev-server.sh                                 # :8080
SERVER_URL="ws://<host>:8080/ws" ./scripts/build-windows.sh
```

## Tests

```bash
./scripts/run-tests.sh          # 17 blocks, ~220 checks
```

Everything the Linux side can prove: the relay's state machine, the audit log and
the credential sentinel, the applet's exact wire frames replayed against the real
server, the console's renderer and input mapping, the regressions from the
2026-09-03 security review, and the C# classes that compile for `net8.0`. `tests/README.md` says what each block covers; the headless-Chrome
blocks need `./tests/setup-browser.sh` once and are skipped, not failed, without
it.

## Documentation

| File | |
|---|---|
| `CLAUDE.md` | Architecture and the non-negotiable constraints. Specification — not edited. |
| `PLAN.md` | The phased build plan and every acceptance test. Specification — not edited. |
| `PROGRESS.md` | Where development actually stands. Start here. |
| `TASKS.md` | Actionable backlog. |
| `MANUAL_TESTS.md` | Windows tests awaiting a human. |
| `ARCHITECTURE.md` | What the code does today. |
| `DECISIONS.md` | Why things are the way they are. |
| `DEV_NOTES.md` | Workarounds and findings from building it. |
| `DEPLOYMENT.md` | Operator's guide. |
| `tests/README.md` | The regression suite, block by block. |
| `shared/protocol.md` | The wire protocol — the single source of truth. |

## Security

The applet is unsigned, so SmartScreen and Defender will flag it. That detection
is correct behaviour for an unsigned binary that injects input; add a path
exclusion on a throwaway test VM, and code-sign it for anything beyond a POC. Do
not attempt to evade AV.

The agent console has a single shared password, not user authentication — see
`DECISIONS.md` D-008 and the limitations in `DEPLOYMENT.md`.
