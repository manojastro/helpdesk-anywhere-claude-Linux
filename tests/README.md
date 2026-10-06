# Regression suite

Everything in here runs on Ubuntu. Nothing in here proves the Windows half works
— see `MANUAL_TESTS.md` for the five tests that need a real machine.

```bash
./scripts/run-tests.sh              # everything available
./scripts/run-tests.sh --no-browser # skip the headless-Chrome blocks
./scripts/run-tests.sh --only ws    # ws | api | browser | dotnet | source
```

39 blocks (with dotnet, Docker/PostgreSQL and headless Chrome available). A block is a separate process with a **fresh server**,
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
| `dotnet/ElevationErrorTests` | 5 | a Win32 code becomes an actionable sentence — "wrong password" and "cannot log on interactively" must not read alike |
| `source/15-windows-invariants` | 2–6 | **the properties a compiler cannot see** in a half that never executes here: no auto-start service, no reboot-deferred cleanup, a pipe path that resolves, teardown that stops capture first, a password that reaches no log, a staging DACL that is not inherited |
| `browser/10-phase1-console` | 1 | `PLAN.md`'s two-tab acceptance verbatim, driving `scripts/mock-host.js` |
| `browser/11-phase3-render` | 3 | `[0x01]`/`[0x02]` framing, **big-endian** headers, canvas sized to the remote's native resolution, dirty-rect placement, FPS/kbps counters, reset on end |
| `browser/12-phase4-input` | 4 | canvas → remote-pixel mapping via the **backing store, not the CSS size**, corners, drag, throttling, wheel sign, `event.code`, blur releases modifiers |
| `browser/13-phase6-exec` | 6 | script pane lifecycle, incremental partial output, full script text audited *before* execution, exactly one `exec.result`, no markup injection |
| `browser/14-phase5-elevation` | 5 | elevation panel lifecycle, interactive mode says the prompt is on the *user's* screen, the password is cleared on send and is in neither `localStorage`, `sessionStorage` nor the DOM, Ctrl+Alt+Del unlocks only on success and sends `kind:"sas"`, the UAC banner follows `host.desktopChanged` |
| `browser/16-csp` | 7 | the CSP is present and locks `script-src` to `'self'`; neither page breaks under it — a violation blocks a resource *silently*, so the block watches `securitypolicyviolation` and then asserts the scripts' effects; `connect-src 'self'` still admits the same-origin `/ws` upgrade |
| `api/30-access` | Admin portal | first-admin bootstrap (configured object ID + Admin role only); Entra role required (no-role identities recorded, flagged, never admitted); one tenant; pending → activation with agent ID/team; CSRF and Origin on state changes; **two applications** — an Agent cannot sign in to the admin portal, cookies and APIs do not cross, the admin app has no `/ws`; Auditor read-only; Supervisor team scoping (history, detail, transcript, notes, reports, people); per-user limits enforced by the relay (scripts, elevation, concurrency); suspension revokes sign-in and live sockets at once; another organisation's records invisible |
| `api/31-persistence` | Admin portal | full ordered timeline; chat stored **before** "sent", retries deduplicated per side, delivered once; notes private and durable; declined / customer-ended / dropped endings; **storage failure visible** (chat not delivered, script not run, record marked incomplete, dashboard banner) by renaming tables mid-session |
| `api/32-restart` | Admin portal | `kill -9` with sessions open → reconciled as `server_restart` with a `session.interrupted` event; retention purges old transcripts (marked, not silently empty), deletes very old sessions, erases expired report files |
| `api/33-reports` | Admin portal | PDF content (metadata, timeline, chat, notes — decoded via the embedded fonts' ToUnicode maps, `tests/lib/pdftext.mjs`); **English + Tamil** rendered with embedded Noto fonts, no `?` substitution; Tamil kept in the CSV, omissions honoured, **no code, no password**; download by requester only, TTL, every request/download/refusal audited; CSV header, filter, formula neutralisation, no chat bodies; export permission; the credential-mode password in no table, log or report |
| `api/34-startup` | Admin portal | `AUTH_MODE=dev` refused under production, on public hosts and behind a proxy; Entra config required; no DB / same ports / same hosts refused; in Entra mode `/auth/dev/login` does not exist |
| `source/25-admin-portal-invariants` | Admin portal | privileged Windows components identical to the golden tag; credential frame forwarded before any DB write and never awaited; no schema column for codes/secrets; the two frontends never call each other's APIs; the image cannot run dev sign-in — each mutation-tested |
| `browser/24-admin-portal` | Admin portal | the definition-of-done flow through both real UIs: admin signs in → technician pending → activated in the UI → session with consent, two-way chat, notes → history, timeline, transcript (markup rendered as text) → PDF export and download → audit; Agent refused by the admin portal; phone width |
| `browser/17-console-shell` | UI | what a technician actually **sees**, which blocks 11–14 cannot: the whole remote frame (landscape and portrait) visible inside the viewport at its aspect ratio with every corner hit-testing to `#remote`; no page scroll at 1366×768 / 1440×900 / 1920×1080; narrow windows collapse the side panels instead of pushing the screen below the fold; the single-use code shown only while usable; a real mid-session `error` (credential elevation refused over `ws://`) never paints a placeholder over the live screen; UAC surfaced in the status bar and viewport outline; every planned toolbar feature disabled. Runs **without** `ALLOW_INSECURE_DEV` — it needs that refusal |
| `unit/40-lifecycle` | Platform 2.0 | the lifecycle table: every phase reachable, terminals final, invalid moves refused with nothing changed, RECONNECTING remembers and validates deferred changes, end reason → terminal phase |
| `ws/12-lifecycle` | Platform 2.0 | the phase over the real wire and in the record (every transition stored in order with its time), phase carried on `peer.joined` / `consent.result` so strict-order clients see the old sequence, CONTROLLING once, hold/resume, reconnect, decline; relay-measured health on both legs and never sent to the applet; `/api/agent/dashboard` counts, completed-today, search/filter, LIKE escaping, another technician sees nothing, sign-in required |
| `browser/41-technician-platform` | Platform 2.0 | idle dashboard (record-backed, placeholder still click-through), PIN card grouping + live countdown + Copy PIN/Link/Invitation text, header device / `HDA-` reference, health graded from a real measurement, zoom −/+, phase in Info, Dashboard dialog (queue switches, search, filter, 4 / 4 message), typing in it reaches no machine, Reboot gone |
| `source/42-platform-invariants` | Platform 2.0 | windows/ untouched since the 2.0 checkpoint; one writer of phases (`setPhase`); no client message names a phase; health/phase never sent to the applet; dashboard SQL pinned to the principal; relay `state` still assigned in exactly four places |
| `ws/13-support-tools` | Platform 2.0 | script library: built-ins, Admin-only management (Supervisor/Auditor read, 403 on write), validation, versioning (CRLF normalised), audit with hash not body; relay provenance — exact match recorded by name, every mismatch kind recorded as such, ad-hoc unchanged, archived not credited, `allowScripts` still refuses; activity (own sessions, readable, no bookkeeping, 404 otherwise); screenshot record (no image, own only, large body rejected, no image column anywhere) |
| `browser/43-support-tools` | Platform 2.0 | two live sessions: tabs fit, library grouped + markup-safe, loading fills editor/shell/privilege, run carries libraryRef to A only, status Running → Finished with exit code and duration, edited script loses libraryRef, per-session pick/status/editor, activity per session, screenshot PNG download named for the session + recorded on it only, chat system lines per session and never sent, System tab |
| `browser/44-admin-scripts` | Platform 2.0 | admin portal Script library: create → visible to technicians, markup shown literally, edit → v2, archive → hidden; Auditor read-only |
| `ws/14-files-clipboard` | Platform 2.0 2b | capability negotiation (v1 applet → `not_supported`, unknown caps dropped); file manager list/mkdir/rename/delete + malformed requests refused unforwarded; upload end-to-end with hash, never overwrites, size/sequence/early-end/oversize/concurrency limits, no partial files; download with flow control and hash; clipboard (length-only audit), sysinfo, script stop; contents and clipboard text in no table/log/audit; hold, `allowFileTransfer`, technician drop cancels |
| `browser/45-files-clipboard` | Platform 2.0 2b | buttons follow capabilities (old applet greyed with reason); file manager browse, upload via picker, download, new folder, rename, delete; per-session file views and transfers; clipboard send/get, cleared on close; system details rendered; Stop for user scripts, explained for SYSTEM |
| `source/45-applet-features-invariants` | Platform 2.0 2b | C# feature code never touches capture/input/desktop/elevation; every path through PathPolicy first; CreateNew, no overwrite, `.hdapart` until hash check, partials deleted, no recursive delete, no root delete, read-only downloads with an ack window; customer notified; no logging; created after consent, routed only after the consent guard, disposed after scripts and before the elevated service |
| `dotnet/PathPolicyTests` | Platform 2.0 2b | the applet's path rules on Linux: canonical forms accepted; relative, `..`, UNC, `\\?\`, ADS, reserved names, forbidden characters, trailing dot/space, over-long refused; unique names never overwrite |
| `ws/15-customer-reconnect` (+ `15b`) | Platform 2.0 P3 | resume token issued at consent only to `resume` applets and never shown to the technician; drop → DISCONNECTED; actions refused / input dropped meanwhile; wrong, foreign and rotated tokens refused; hold survives; no grace for old applets, the customer's End Session or ended sessions; rate limit; timeline and `host_reconnect_count`; (b) grace expiry ends as `customer_disconnected` |
| `dotnet/ReconnectTests` | Platform 2.0 P3 | **the applet's real `SessionClient.cs` against the real relay**: join with protocol 2, token kept in the transport, line cut → Reconnecting/Reconnected once, same session CONNECTED, token rotated, traffic flows, a relay-side end is final |

### Why a source-invariant block exists

Everything under `windows/` cross-compiles on Ubuntu and runs only on Windows,
so for that half the compiler is the *only* automated feedback — and a compiler
is perfectly happy with a service that starts at boot, a device path that throws
at runtime, or a directory whose ACL is inherited from somewhere permissive. Two
of the eleven defects found reviewing Phase 5 were exactly that shape.

`source/15` asserts those properties textually. It is a crude tool, deliberately
tied to specific constraints in `CLAUDE.md` and ordering rules in `PLAN.md`, and
every check in it was confirmed to **fail** when its invariant is broken rather
than merely to pass today. It is a backstop for MT-06, not a substitute.

## Sign-in and the database

Since the admin-portal release the server needs PostgreSQL and a signed-in
technician. `tests/lib/server.sh` starts (or reuses) a throwaway container
`hda-test-pg` on `127.0.0.1:55432` — or uses `HDA_TEST_PG_ADMIN_URL` /
`HDA_TEST_DATABASE_URL` if you point it at your own — and recreates the test
database on every `server_reset_state`. The server runs with `AUTH_MODE=dev` on
loopback (the only place that mode is allowed); after each start
`tests/lib/provision.mjs` signs in a bootstrap Admin and an active Agent and
exports `HDA_ADMIN_COOKIE` / `HDA_AGENT_COOKIE`. Technician sockets use
`openAgent()`; customer sockets stay anonymous, like the real applet.

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
| `HDA_TEST_PORT` | `8099` | technician console; kept off 8080 so a running dev server or container is untouched |
| `HDA_TEST_ADMIN_PORT` | `8098` | admin portal |
| `HDA_TEST_PG_PORT` | `55432` | throwaway PostgreSQL container `hda-test-pg` |
| `AUDIT_DIR` | `/tmp/hda-test-audit` | wiped between blocks that assert on it |
| `SERVER_LOG` | `/tmp/hda-test-server.log` | the credential scan greps this |
| `SHOT_DIR` | unset | set it to collect screenshots from block 10 |
