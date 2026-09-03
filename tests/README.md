# Regression suite

Everything in here runs on Ubuntu. Nothing in here proves the Windows half works
— see `MANUAL_TESTS.md` for the five tests that need a real machine.

```bash
./scripts/run-tests.sh              # everything available
./scripts/run-tests.sh --no-browser # skip the headless-Chrome blocks
./scripts/run-tests.sh --only ws    # ws | browser | dotnet
```

17 blocks, ~220 checks. A block is a separate process with a **fresh server**,
because the per-IP join rate limiter and the code TTL are process state: sharing
one server would make a block's result depend on which blocks ran before it.

## What each block covers

| Block | Phase | Covers |
|---|---|---|
| `ws/01-phase1-happy` | 1 | create → join → connectRequest → consent → relay; pre-consent frames refused; wrong code; single-use burn; `agent.end` teardown |
| `ws/02-phase1-ratelimit` | 1 | 5 bad `host.join` per IP per minute, the 6th refused, a refusal does not extend the window |
| `ws/03-phase1-expiry` | 1 | an unused code expires (run with `SESSION_CODE_TTL_MS=1500`) |
| `ws/04-phase1-protocol` | 1 | consent decline, role handshake, malformed JSON, input before consent, peer-drop teardown |
| `ws/05-phase1-audit` | 1 | every lifecycle record; **constraint #6** — a sentinel password appears in neither the audit log nor server output, and credential elevation over non-`wss:` is refused |
| `ws/07-security` | all | the 2026-09-03 review: console auth on the **normalised** path, `/ws` Origin policy, `agent.create` rate limit and ceiling |
| `ws/06-applet-wire` | 2 | the byte-exact frames `SessionClient.Send<T>()` emits, replayed against the real relay: join, retype after a bad code, consent, decline, close codes |
| `dotnet/ConfigTests` | 2 | `AppletConfig` URL normalisation and code validation |
| `dotnet/WireTests` | 1–6 | `Shared/Protocol.cs` serialises to the wire shape in `shared/protocol.md` |
| `dotnet/TileTests` | 3 | `TileGrid` dirty-rect coalescing and clipping, incl. a random-grid invariant |
| `dotnet/KeyMapTests` | 4 | `event.code` → VK, extended-key flags, modifier coverage |
| `dotnet/StagingTests` | 6 | a wire-supplied exec id cannot stage a script outside the session's temp folder |
| `browser/10-phase1-console` | 1 | `PLAN.md`'s two-tab acceptance verbatim, driving `scripts/mock-host.js` |
| `browser/11-phase3-render` | 3 | `[0x01]`/`[0x02]` framing, **big-endian** headers, canvas sized to the remote's native resolution, dirty-rect placement, FPS/kbps counters, reset on end |
| `browser/12-phase4-input` | 4 | canvas → remote-pixel mapping via the **backing store, not the CSS size**, corners, drag, throttling, wheel sign, `event.code`, blur releases modifiers |
| `browser/13-phase6-exec` | 6 | script pane lifecycle, incremental partial output, full script text audited *before* execution, exactly one `exec.result`, no markup injection |

## Console authentication

Set `CONSOLE_PASSWORD` and the whole suite runs against an authenticated console
(`DECISIONS.md` D-008) — the browser blocks authenticate, the join page must
still work without. Both modes are expected to be green; run it both ways after
touching `server/src/auth.ts`.

## Headless Chrome

Puppeteer and Chrome are **not** dependencies of the product, so they are not in
`server/package.json` and not in the tree. `tests/setup-browser.sh` installs both
into `~/.cache/helpdesk-anywhere` (override with `HDA_TEST_CACHE`):

```bash
./tests/setup-browser.sh
```

`tests/lib/browser.mjs` finds them there, or at `HDA_PUPPETEER_HOME` /
`CHROME_PATH` if you point it elsewhere. If neither is present the browser
blocks are **skipped with a warning**, not failed — the rest of the suite still
runs on a machine without a browser.

On a server install Chrome also needs libraries that are not there by default;
`setup-browser.sh` prints the exact `apt-get` line if the binary will not start.

## Ports and paths

| Variable | Default | |
|---|---|---|
| `HDA_TEST_PORT` | `8099` | kept off 8080 so a running dev server or container is untouched |
| `AUDIT_DIR` | `/tmp/hda-test-audit` | wiped between blocks that assert on it |
| `SERVER_LOG` | `/tmp/hda-test-server.log` | the credential scan greps this |
| `SHOT_DIR` | unset | set it to collect screenshots from block 10 |
