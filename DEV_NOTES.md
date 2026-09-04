# Dev notes

Workarounds, incompatibilities and improvements discovered while building.
`PLAN.md` and `CLAUDE.md` are authoritative specifications and are **not** edited;
anything learned along the way is recorded here instead.

---

## Phase 1 — Server: sessions, pairing, portal (2026-09-02)

### `scripts/mock-host.js` lives outside the only npm package
`PLAN.md` puts the mock host at `scripts/mock-host.js`, but the only `node_modules`
tree in the repo is `server/node_modules`. Node resolves bare specifiers from the
*importing file's* directory upwards, so a plain `import { WebSocket } from "ws"`
fails with `ERR_MODULE_NOT_FOUND` regardless of the cwd or the `--prefix` used.

Resolved with `createRequire` anchored at `server/package.json`, so the script runs
from any cwd without adding a second `node_modules` tree or moving the file:

```js
const require = createRequire(path.join(__dirnameEquivalent, "../server/package.json"));
const { WebSocket } = require("ws");
```

### Two config keys were added that `PLAN.md` does not name
Both are in `server/src/config.ts` and `.env.example`, environment-variable only.

- **`AGENT_NAME`** (default `Support Agent`). `shared/protocol.md` requires
  `host.connectRequest` to carry an `agentName`, and CLAUDE.md constraint #1 requires
  the consent modal to *name the requesting agent* — but the console has no
  authentication (`PLAN.md` "out of scope"), so there is no signed-in identity to
  derive the name from. When portal auth arrives in Phase 7, this should become the
  authenticated agent's name rather than a static string.
- **`TRUST_PROXY`** (default `0`). The join rate limiter is keyed on client IP and
  the credential-mode transport check needs to know whether the *client's* leg was
  TLS. Behind Caddy (`PLAN.md` 7.3) the socket peer is Caddy and the connection to
  Node is plain `ws`, so both facts live in `X-Forwarded-For` / `X-Forwarded-Proto`.
  Those headers are trivially forged when nothing is in front, which would both
  defeat the rate limiter and fake a secure transport — hence off by default and set
  explicitly in `docker-compose.yml`, where Caddy really is in front.

  When trusted, the client IP is taken from the **last** `X-Forwarded-For` entry —
  the one the trusted proxy appended. Earlier entries are attacker-supplied.

### The credential-elevation guard is implemented in Phase 1, not Phase 5
`PLAN.md` schedules elevation for Phase 5, but `agent.requestElevation` traverses the
Phase 1 relay the moment the relay exists. Leaving the guard until Phase 5 would mean
Phases 1–4 forward an admin password unchecked. So `signaling.ts` already enforces,
for `mode:"credential"`:

- hard refusal on a non-secure transport → `error{code:"insecure_transport"}`, and the
  frame is never forwarded;
- the per-session attempt cap → `error{code:"elevation_rate_limited"}`;
- audit of the *fact*, *mode*, *domain* and *username* only — never the password;
- verbatim forwarding of the original frame, never re-serialised, so the payload is
  not copied into a new buffer on its way through.

No Phase 5 UI was built; the console's elevation fieldset stays disabled.

### `SessionStore` does not close sockets
`sessions.ts` holds the socket references but never closes them. `signaling.ts` owns a
single `teardown()` that notifies the surviving peer, closes both sides and audits.
`SessionStore.end()` only marks the session ended and drops it from the map, returning
it so the caller can do the socket work. That keeps teardown idempotent: the `close`
handlers that fire as a consequence find the session already gone and stop, instead of
recursing.

### Codes keep their leading zeros
`crypto.randomInt(0, 1e6)` is zero-padded to six digits, so `004821` is a valid code.
Dropping padded values would waste ~10% of the keyspace; the code is always read and
typed as six characters.

### A refused `host.join` does not close the socket
The applet needs to show "wrong code" and let the user retype (`PLAN.md` 2.2), so the
socket stays open and the role stays undeclared. Guessing is capped by the per-IP
limiter rather than by forcing a reconnect — and the limiter is checked **before** the
code lookup, so response timing cannot distinguish a real code from a fake one.

---

## Phase 2 — Windows applet: connect, code entry, consent (2026-09-03)

### The server URL is baked in at publish time, via `AssemblyMetadata`
`PLAN.md` 2.2 wants the code-entry form pre-filled "from `config`", but the applet
has no config file to read — it is a single self-contained .exe the end user
double-clicks, and asking a stressed non-technical caller to type a hostname
alongside the code is exactly the friction the six-digit code exists to avoid.

The URL is therefore compiled in: `Applet.csproj` maps the `ServerUrl` MSBuild
property to `[assembly: AssemblyMetadata("ServerUrl", …)]`, and `AppletConfig`
reads it back by reflection. `scripts/build-windows.sh` gained a derivation step —
`SERVER_URL` wins, else `wss://$PUBLIC_HOST/ws`, taking `PUBLIC_HOST` from the
environment or from the repo `.env` that `docker-compose` already uses. With
neither set the csproj default (`wss://localhost:8080/ws`) is kept, so a plain
`dotnet publish` still produces a working dev binary.

The field stays editable behind a "Server address" link, per `PLAN.md`. Input is
normalised: a bare host becomes **`wss:`**, never `ws:` (CLAUDE.md "Public URL and
TLS"), `https`/`wss` and `http`/`ws` are accepted, everything else is refused, and
an empty path becomes `/ws`. Plaintext is only ever reached by typing `http://` or
`ws://` deliberately, and the consent dialog then shows an unencrypted-connection
warning to the person being asked to consent.

### Reconnect-with-backoff applies to the initial dial only
`PLAN.md` 2.3 asks for "reconnect with backoff on transient drop, but hard-stop and
exit if the session is ended". Those turn out to be the same event past the join:
`signaling.ts` tears the session down the moment either peer's socket closes, and
the code was already burned at `host.join`, so there is nothing left to reconnect
*to*. `SessionClient.ConnectAsync` therefore retries four times with 0.5→4 s backoff
while dialling, and any drop after that is terminal — the applet closes and exits.
A pre-consent drop is not terminal: the code form comes back with an error so the
user can retry, which is the case the backoff is really protecting.

### Two send queues, built before there are frames to put in them
`PLAN.md` 2.3 asks that video never block control. `SessionClient` has an unbounded
control channel and a **bounded (capacity 2, `DropOldest`)** frame channel, and the
send pump always drains control first. Nothing writes frames until Phase 3, but the
shape had to be decided now: with one queue, a slow uplink delays the user's "End
Session", which is constraint #3. Dropping a stale frame is free; the next one
supersedes it.

### Consent: every exit other than Accept is a Decline
`PLAN.md` 2.2 says the dialog cannot be dismissed by Esc. Esc is swallowed, and
Alt+F4 / the system Close command are intercepted (`WM_SYSCOMMAND` / `SC_CLOSE`) and
resolved to **Decline** rather than to nothing, so no dismissal route can leave the
applet in a state where the session proceeds unanswered. There is deliberately no
`AcceptButton`: Enter must not consent on the user's behalf, and focus starts on
Decline.

### The indicator re-asserts its z-order instead of P/Invoking
Constraint #2 says non-hideable. A 2 s timer toggles `TopMost` off/on, which
re-inserts the window at the top of the topmost band **without** stealing focus from
whatever the user is typing into — `Activate()` would. The same tick restores it if
it was minimised or left off-screen by a resolution change. This needs no Win32 call,
so Phase 2 adds nothing to `Interop/` despite the conventions reserving that folder
for it.

The window is draggable (getting it out of the way is legitimate; hiding it is not),
closing it from the taskbar ends the session rather than hiding it, and
`IndicatorForm.ShowNotice()` exists unused — Phase 5 needs it to surface elevation
on the indicator (constraint #6).

### No `.Designer.cs` files
There is no WinForms designer on Ubuntu, so all three forms are laid out in code.
This is not a workaround to undo later: hand-written layout is what keeps them
reviewable in a diff, which matters for the two windows that carry constraints #1–#3.

---

## Phase 3 — Screen capture + streaming (2026-09-03)

### `IScreenCapture` carries the virtual-screen *origin*, not just its size
`PLAN.md` 3.1 sketches `IScreenCapture { Bitmap Grab(); Size Bounds { get; } }`. A
size is not enough: with a second monitor placed left of or above the primary,
`SM_XVIRTUALSCREEN` / `SM_YVIRTUALSCREEN` are negative, and both the `BitBlt` source
coordinates and the Phase 4 input mapping need that origin. The interface therefore
also exposes `Rectangle VirtualScreen`. `Bounds` is kept as the spec names it.

`Grab()` returns `Bitmap?`, not `Bitmap`: `BitBlt` fails while the input desktop is
switching (UAC, lock screen), which is expected and transient. A null frame is skipped;
throwing there would kill the stream every time Phase 5 does its job.

### The GDI surfaces are created once, and rebuilt only when the desktop changes
`PLAN.md` warns that per-frame `CreateCompatibleDC`/`CreateCompatibleBitmap` is the
usual cause of a 3 FPS GDI capture. They are created once in the constructor. Each
`Grab()` re-reads the virtual-screen metrics and rebuilds only if they changed — a
resolution change or a hot-plugged monitor — and raises `BoundsChanged`, which forces
a keyframe because every cached tile hash has just become meaningless.

`CreateCompatibleBitmap` is called against the **screen** DC, not the memory DC: a
bitmap made compatible with a fresh memory DC is 1bpp monochrome, which is a
classic and very confusing way to capture a black-and-white screen.

`GetIconInfo` hands back two bitmaps the caller owns. At 10 FPS, leaking them
exhausts the GDI handle quota in minutes, so they are deleted in a `finally`.

### Dirty-rect diffing refuses to run on a bottom-up bitmap
A bottom-up DIB has a **negative** stride with `Scan0` pointing at the last row, so
copying `stride * height` bytes forward from it reads off the end of the buffer — an
access violation, not an exception. `Image.FromHbitmap` yields top-down in practice,
but the code does not gamble on it: a non-positive stride forces a full keyframe
instead of diffing.

### Tile coalescing was extracted so it could be tested on Ubuntu
`TileGrid` holds the tile arithmetic and depends only on `System.Drawing.Primitives`
(`Rectangle`), not on GDI or `System.Drawing.Common`. That makes the one piece of
Phase 3 arithmetic that is easy to get subtly wrong — and expensive to debug through
a screenshot — runnable on the dev machine. 12 cases pass, including a 200-grid
random invariant: every changed tile covered exactly once, no unchanged tile ever
inside a rect, and edge tiles clipped to the frame.

One JPEG per changed tile was rejected: a blinking caret dirties a tile every frame,
and per-tile encoder setup and headers cost more than the pixels. Adjacent changed
tiles merge into one rect, and past 60% of the grid a single full frame wins outright.

### No keyframe-on-resize message was added
`PLAN.md` 3.3 asks for a keyframe "on any client resize". No such agent→host message
exists in `shared/protocol.md`, and none was added, because it is not needed: the
canvas backing store is fixed at the remote's native resolution and only CSS scales
it (`PLAN.md` 3.4 requires exactly that for input mapping), so a browser resize never
discards a pixel. The 5-second keyframe covers everything else.

### Backpressure is handled by not capturing at all
`PLAN.md` 3.2 says to skip a frame if the previous send has not completed. The check
is `SessionClient.PendingFrames > 0`, tested *before* the grab, so a slow link costs
neither a capture nor a JPEG encode — and the frame channel's `DropOldest` policy is
the second line of defence rather than the first.

---

## Phase 4 — Remote input injection (2026-09-03)

### A window-level `mouseup` injected stray clicks into the user's desktop
Found by the Phase 4.1 harness, not by reading the code. The mouseup listener is on
`window` rather than the canvas so that a drag released *outside* the canvas still
sends the button up — otherwise the remote machine is left mid-drag. But that also
fired for every click on the console's own UI: pressing the "Alt+Tab" button sent a
mouse-up into the user's desktop before the chord.

Fixed with a `draggingFromCanvas` flag set on canvas `mousedown` and cleared on the
first `mouseup`. The harness now asserts that clicking a console button produces key
frames only.

### `dblclick` is not forwarded
`PLAN.md` 4.1 lists `dblclick` among the events to capture. It is captured, but only
to `preventDefault()` the browser's text selection: the two `mousedown`/`mouseup`
pairs that precede it already produce a double-click on Windows, and forwarding a
third pair would turn every double-click into a triple-click.

### Wheel deltas are inverted and quantised
The DOM's `deltaY` is positive scrolling *down*; Windows' `WHEEL_DELTA` is positive
scrolling *away from the user*. The sign is flipped, the magnitude quantised to
multiples of 120, and `deltaMode` handled so a line-scrolling mouse and a pixel-
scrolling trackpad agree.

### Held keys are released on both sides, for different reasons
The applet releases on session end, peer drop and the crash path (`PLAN.md` 4.2). The
*console* also releases on blur, because the browser can swallow a `keyup` outright:
press Alt+Tab in the agent's own browser and the page never sees Alt come back up. A
stuck Ctrl on the user's machine after the helper has exited is invisible to them and
very hard to diagnose.

### `wVk` must be zero when sending a scancode
`SendInput` with `KEYEVENTF_SCANCODE` ignores `wScan` and uses `wVk` if `wVk` is
non-zero. The injector sets `wVk = 0` whenever it has a scancode, and falls back to
the virtual key (dropping the `KEYEVENTF_SCANCODE` flag) only when `MapVirtualKey`
returns 0 for a key with no scancode on the current layout.

### The coordinate mapping is verified against the backing store, on Linux
The "click lands short of where the agent aimed" bug is invisible in code review and
obvious in a test: with a 1600×900 remote desktop displayed in a 998px-wide canvas, a
centre click must map to x=800, and the CSS-pixel bug would give ~499. The harness
asserts both, plus the corners and the clamp, without any Windows involvement.

One browser detail is worth recording: at the exact sub-pixel edge of a fractional
bounding rect, `elementFromPoint` returns the *parent*, so the corner test clicks two
pixels inside. That is a hit-testing artefact, not a mapping bug.

---

## Phase 6 — Remote script execution (2026-09-03)

### `host.execResult` gained a `partial` flag — protocol change, all three mirrors
`shared/protocol.md` said "partial output may stream before the final result" but gave
no way to tell a chunk from the real answer. Rather than invent a sentinel exit code
or a second message type, `host.execResult` gained an optional `partial: true`.
Chunks carry `exitCode: -1` and only the delta since the last chunk; exactly one
non-partial frame closes the run with the real code.

`shared/protocol.md`, `server/src/protocol.ts` and `windows/Shared/Protocol.cs` were
changed together, per the CLAUDE.md convention. `signaling.ts` needed one change with
it: audit `exec.result` **only** for the final frame, or a chatty script writes an
audit record every 250ms.

### Output is read through the event pipeline, not by reading a stream to the end
`PLAN.md` 6.1 warns that a single synchronous read deadlocks on large output — the
other stream fills its pipe buffer and the child blocks forever. `OutputDataReceived`
/ `ErrorDataReceived` with `BeginOutputReadLine` reads both concurrently without
managing two tasks by hand.

The 1 MB cap is enforced as lines arrive, not at the end, so a runaway loop cannot
exhaust memory before anything notices.

### `asSystem` is refused, not silently downgraded
Until Phase 5 exists there is no elevated service to route to. The request is refused
with a clear message rather than run as the interactive user: quietly executing at a
lower privilege than the agent asked for would misreport what actually happened on the
user's machine.

### The script pane never uses `innerHTML`
Script text is arbitrary and comes from the console's own textarea, but the run
history renders it with `textContent` and `createTextNode` throughout. The harness
asserts that a script containing `<img src=x onerror=...>` produces no elements. The
agent console is unauthenticated in this POC (`PLAN.md` "out of scope"), so the pane
that echoes attacker-influencable text back is not the place to be relaxed.

### What the Linux harness covers
21 checks: the pane gated on consent, the `agent.exec` frame's shape, incremental
rendering of partial chunks, the final exit code and re-enable, the run history, the
markup-injection guard, `asSystem` reaching the wire, and the two audit guarantees
that matter — the **full script text recorded before execution**, and exactly one
`exec.result` per run no matter how many chunks streamed. Actually executing
PowerShell needs Windows (MT-04).

---

## Phase 7 — Package, deploy, external access (2026-09-03)

### The audit log silently failed the first time it ran in Docker
The container's `node` user is uid 1000; the bind-mounted `./audit` directory
belonged to uid 1001, the account that checked the repo out. Every append hit
`EACCES`, and because `audit()` is deliberately non-throwing, the only evidence was
one line on stderr among the startup noise. The deployed stack ran for several
minutes looking healthy while recording nothing — with CLAUDE.md constraint #5
quietly broken.

Two fixes, because either alone is insufficient. The container now runs as
`${HOST_UID}:${HOST_GID}`, which the deploy scripts fill from `id -u`/`id -g`. And
the server now **refuses to start** unless it can write a probe file into the audit
directory: an unauditable support tool is worse than none, and a silent failure is
worse than a loud one.

This is the single most valuable thing the deployment verification found, and it
would not have shown up in any unit test.

### `.env` is data, not a shell script
`scripts/deploy.sh` sourced `.env` to read `PUBLIC_HOST`. With
`AGENT_NAME=Support Agent` unquoted, `source` runs `Agent` as a command; a value
containing a backtick would run whatever is inside it. Both `deploy.sh` and
`verify-deployment.sh` now extract individual keys with `sed` instead. `.env.example`
also quotes the values that contain spaces.

### Console auth had to live in the app, not in Caddy
The Phase 0 `Caddyfile` left a TODO to add `basic_auth` before going public. Under
the ngrok profile there is no Caddy in the path at all, and a proxy-level basic auth
cannot gate the **WebSocket**, which is what actually creates session codes. Putting
it in the app covers both topologies and both surfaces: Basic auth on the page, then
an HttpOnly cookie that `agent.create` requires. The applet has no cookie and never
needs one, so nothing about the host side changes.

### Compose profiles keep the ngrok→DuckDNS migration free of code changes
The `app` service is byte-identical in both profiles. It already read the client's
real IP and scheme from `X-Forwarded-*` under `TRUST_PROXY` — which is true behind
ngrok's edge exactly as it is behind Caddy — and the console builds join links from
the browser's own origin rather than from `PUBLIC_HOST`. So switching is a profile
flag, a `PUBLIC_HOST` value and one applet rebuild.

`${NGROK_URL:+--url=${NGROK_URL}}` in the compose `command` expands to nothing when
the variable is unset, so the optional static domain needs no second compose file.

### Three smaller gaps closed in the same pass
- `scripts/dev-server.sh` sourced `.env` exactly as `deploy.sh` did, with the same
  arbitrary-execution hazard. It now parses keys with a `while read` loop.
- `server/.dockerignore` was missing, so every build uploaded 43 MB of host
  `node_modules` to the daemon and a stale host `dist/` could shadow what the image
  builds for itself.
- `IndicatorForm.ShowNotice` permanently replaced the "they can see and control
  this screen" line. `PLAN.md` 6.3 calls the script notice *transient*, so it now
  reverts after twelve seconds, with a `sticky` overload for Phase 5's elevation
  banner, which describes a state that is still true.

### The browser harnesses now run against the deployed container
Parameterising them on `BASE`/`WS_URL` and adding `page.authenticate` turned the
Phase 3/4/6 suites into deployment regression tests. All 60 checks pass against the
Docker image with console authentication enabled — which is a materially stronger
statement than passing against `tsx` on the dev server.

One harness bug surfaced in the process: a check counted `exec.result` records
across the whole audit file, which is append-only and now persists between runs. It
is scoped to the run's own execution id.

---

## Test environment

### The only part of the applet that runs on Ubuntu
`AppletConfig` has no WinForms dependency, so its URL normalisation and code
validation were exercised on Linux by `<Compile Include="…/AppletConfig.cs" />` into
a throwaway `net8.0` console project in the session scratchpad (22 cases, all
passing). Nothing else in `windows/` can be executed here — see CLAUDE.md's hard
environment boundary. Like the Phase 1 harness, that project is not committed.

The other half that *can* be checked without Windows is the wire: the exact JSON
`SessionClient.Send<T>()` produces was dumped by linking `Shared/Protocol.cs` into a
second scratchpad project, then replayed verbatim against the running relay over
`ws`. That covers join → `host.connectRequest` → consent → `agent.end`, plus the
bad-code refusal, the retype-on-the-same-socket path the applet depends on, and the
decline teardown — 12 checks, all passing. What it does not and cannot cover is
everything the .exe does on a real desktop, which is exactly what the 🪟 acceptance
test is for.

### Phase 3.4 is verifiable on Ubuntu, and was
The Windows capture half cannot run here, but everything downstream of the wire can:
the renderer harness drives the real agent console in headless Chrome, feeds it real
`[0x01]`/`[0x02]` frames built byte-for-byte as `ScreenStreamer` emits them, and reads
the pixels back off the canvas with `getImageData`. 19 checks pass, covering canvas
sizing at native remote resolution, dirty-rect placement, big-endian header decoding
(a little-endian reader would put the `x=400` tile at 36,865), the FPS/kbps counter
under a ~10 FPS load and its return to zero, and the reset on session end.

The JPEG fixtures are generated by the same browser engine that decodes them
(`canvas.toDataURL("image/jpeg")`), because this machine has neither Pillow nor
ImageMagick and neither is worth adding as a dependency.

### Phase 4.1 is verifiable on Ubuntu too
The harness drives real mouse and keyboard events at the real console and asserts the
exact `agent.input` frames that reach the host: coordinate mapping at the centre and
all corners, the three buttons, a drag, move throttling, wheel sign and magnitude,
`event.code` rather than `event.key`, modifier release on blur, the special-key
chords, and silence both before consent and after the session ends. 20 checks.
`KeyMap` is dependency-free and linked into a Linux harness the same way `TileGrid`
is — 12 more checks.

### Headless browser for the console (dev machine only, not a repo dependency)
`PLAN.md` Phase 1's acceptance test says "open two browser tabs". To run that
unattended, Chrome for Testing 152 was installed under the session scratchpad and
driven with Puppeteer. Two snags on Ubuntu 24.04:

1. `npx puppeteer browsers install chrome` fails with
   `IncompleteInstallationError: All providers failed`, while the same zip downloads
   fine with `curl` from `storage.googleapis.com/chrome-for-testing-public/...`.
   Extract it manually and pass `executablePath` to `puppeteer.launch`.
2. The extracted binary needs runtime libraries that are not on a server install:
   `libatk1.0-0t64 libatk-bridge2.0-0t64 libxcomposite1 libxdamage1 libxfixes3
   libxrandr2 libgbm1 libasound2t64 libatspi2.0-0t64 libcups2t64 libnss3 libnspr4
   libxkbcommon0 libpango-1.0-0 libcairo2`. Without them Chrome exits with
   `error while loading shared libraries: libatk-1.0.so.0`.

Neither Puppeteer nor Chrome is a dependency of the project — they live in the
scratchpad and nothing in `server/package.json` references them.

Two further quirks of that build, both test-side only:

- `Page.captureScreenshot` intermittently never resolves. Screenshots are evidence,
  not assertions, so the harness races them against a timeout.
- The console page produces one `404` in the browser console for `/favicon.ico`,
  which Chrome requests on its own; the portal specifies no icon. It is not a page
  error, and the URL is on the console message's `location()`, not in its `text()` —
  filtering on the text alone does not exclude it. Adding a favicon would remove the
  404 but is not called for by `PLAN.md`.

### The harnesses were promoted into `tests/` (2026-09-03)
They originally lived in the session scratchpad, because `PLAN.md`'s file tree has
no test directory and `scripts/mock-host.js` is the tool the plan actually
specifies. That was the right call for one session and the wrong one for the
project: `/tmp` is one reboot from empty, and a fresh session could not re-run a
single check that the six constraints still hold.

Everything above now lives in `tests/`, run by `./scripts/run-tests.sh` — 15
blocks, ~190 checks. What changed in the move:

- Port, audit directory and server log come from the environment
  (`HDA_TEST_PORT`, default **8099**, deliberately not 8080) rather than being
  hard-coded, so a run cannot disturb a dev server or the running container.
- Puppeteer and Chrome moved to `~/.cache/helpdesk-anywhere`, installed by
  `tests/setup-browser.sh`. They are still not dependencies of the product and
  are still absent from `server/package.json`. When they are missing the browser
  blocks are **skipped with a warning**, so the suite stays usable on a machine
  with no browser.
- The console-auth handling that phases 3/4/6 each carried inline is now one
  helper (`tests/lib/browser.mjs` → `openConsole`), and the whole suite is
  expected green both with and without `CONSOLE_PASSWORD`.
- The four C# suites keep the `<Compile Include>` trick — they link the
  dependency-free classes straight out of `windows/` into a plain `net8.0`
  project — but with repo-relative paths, and they are outside
  `HelpdeskAnywhere.sln` so `dotnet build` of the product is unaffected.

---

## Security review — 2026-09-03

A full read of the server, the console and the applet against the six constraints
in `CLAUDE.md`, with every claim probed against a running instance rather than
argued from the source. Four defects were found and fixed; each has a regression
test that fails against the previous code.

### S-1 — console authentication could be walked around with path traversal

`auth.ts` matched the **raw** request path against the list of routes the end user
must reach without credentials (`/j/`, `/download/`, `/healthz`). `express.static`
then resolved `..` itself, so:

```
GET /download/../portal.html   → 200, agent console served, no credentials
GET /j/../portal.js            → 200
GET /download/..%2fportal.js   → 200
```

Impact was bounded — traversal *above* `server/public` was correctly refused by
`express.static`, and the WebSocket gate on `agent.create` is a cookie the page
cannot mint, so no session could actually be created — but a protected route was
being served to an unauthenticated caller, which is a bypass regardless of what
the attacker gains from the HTML.

Fixed by normalising (percent-decode, then `path.posix.normalize`) before the
match, in `normalizePath()`. A path containing a NUL or a backslash is matched
raw rather than normalised, so neither can be used to smuggle one form past the
other.

### S-2 — the `/ws` upgrade accepted any browser Origin

Any page on any site could open a socket to the relay. With console
authentication on, current browsers do not attach a `SameSite=lax` cookie to a
cross-site WebSocket handshake, so the practical exploit was blocked by the
browser rather than by us — which is not a control this project should be
relying on for a *remote-control console*.

`verifyClient` now compares the Origin's host against the request's own `Host`,
`PUBLIC_HOST`, and an optional `ALLOWED_ORIGINS` list. **A missing Origin is
still accepted**, and must be: the applet is not a browser and sends none. Origin
is a header a browser imposes on its own pages, not a credential — demanding one
would break every non-browser client while stopping nothing.

### S-3 — `agent.create` had no rate limit and no ceiling

`host.join` was rate-limited from Phase 1; `agent.create` was not, and nothing
capped live sessions. Each create burns a code from the 1e6 space, holds a map
entry for the TTL, and writes an audit record — so an unbounded create is an
unbounded write to both the session map and the audit file. With
`CONSOLE_PASSWORD` unset, which is the default and the state of any deployment
before the operator sets one, that is reachable by anyone at all.

Now `CREATE_ATTEMPTS_PER_MINUTE` (default 10, per IP) and `MAX_LIVE_SESSIONS`
(default 500). Both refuse with the existing `rate_limited` error, so the three
protocol mirrors did not need to change.

### S-4 — a wire-supplied exec id chose the staged script's path

`ScriptRunner` built the staging path as
`Path.Combine(_tempDir, $"{request.Id}{extension}")`. `Path.Combine` **discards
its first argument when the second is rooted**, so an id of `C:\Windows\Temp\x`
staged and executed the script there, and `..\..\Startup\x` escaped upward.

The agent is already authorised to run arbitrary scripts, so this is not a
privilege gain for the agent — but it defeats constraint #4: the session's temp
folder is deleted on teardown, and a file written outside it is not. A script
dropped into Startup survives the reboot the constraint promises it will not.

Fixed by `ScriptStaging.SafeFileName()`, which maps everything outside
`[A-Za-z0-9_-]` to `_` and caps the length at 64. Dots are excluded as well as
separators, so no staged name can contain `..` under any reading. Kept
dependency-free so it is unit-testable on Linux — `tests/dotnet/StagingTests`,
17 cases.

### Also tightened

- `.env` is chmod 600 by both deploy scripts. It holds the console password and
  the ngrok authtoken, and was 664 — a world-readable secrets file is a leak no
  amount of TLS repairs.
- The control-frame size cap counted UTF-16 code units, not bytes; a multi-byte
  payload could be three times the intended 256 KB. Now measured on the frame.
- `docker-compose.local.yml`'s documented command omitted `HOST_UID`/`HOST_GID`,
  so a hand-run stack on any machine whose uid is not 1000 hit the audit-writable
  guard and restart-looped. The header now carries the working command.

### Reviewed and found sound

- **TLS.** `ClientWebSocket` uses default certificate validation everywhere; there
  is no `RemoteCertificateValidationCallback` in the tree, so no bypass. A bare
  hostname typed into the applet normalises to `wss:`, never `ws:`, and the
  consent dialog grows an explicit warning when the transport is not encrypted.
- **Credential handling (constraint #6).** The password is never read, never
  re-serialised and never logged: `relayElevation` forwards the frame verbatim
  and audits only mode, domain, username and outcome. `redact()` is the single
  choke point for every audit write. A sentinel-password scan over the audit log
  and the server's stdout is part of the suite (`ws/05`).
- **XSS.** No `innerHTML`, `insertAdjacentHTML`, `document.write`, `eval` or
  `new Function` anywhere in the console or the join page; script text and run
  history go through `textContent`, and `browser/13` asserts a `<img onerror>`
  payload creates no element.
- **Secrets in the repo.** No `.env` in the working tree or anywhere in history;
  the only tracked variant is `.env.example`, which holds placeholders.
- **Rate-limiter keying.** `TRUST_PROXY=1` is set in `docker-compose.yml`, so the
  limiter sees the real client rather than treating the whole deployment as one
  IP — which would have made five typos a global lockout.

---

## Phase 5 — UAC / Secure Desktop (implemented, Windows acceptance pending)

Every line of this phase is untestable on Ubuntu: it cross-compiles, and nothing
more. `MANUAL_TESTS.md` → MT-06 is the acceptance test, and it must be run twice —
once from a local-administrator account and once from a standard user account.
What follows is what a reader needs to debug it on the day.

### The shape

```
Applet.exe (user)          WS to the relay, UI, user-desktop capture
   │ one UAC prompt (mode A) or none at all (mode B)
   ▼
--install-service          elevated; copies itself to %ProgramData%, CreateService, StartService
   ▼
--run-service (SYSTEM, session 0)
   │ polls OpenInputDesktop every 200ms
   ├── CreateProcessAsUser ──► --desktop-helper (SYSTEM, user's session, lpDesktop=WinSta0\Winlogon)
   └── named pipe ──────────► the applet, for `asSystem` scripts
```

All three are the same .exe (`DECISIONS.md` D-009).

### Ordering that is not optional

`SetThreadDesktop` binds the **calling thread**, and every DC and bitmap inherits
whichever desktop was current when it was created. `DesktopHelper.Run` therefore
does `OpenDesktop` → `SetThreadDesktop` before it constructs anything at all.
Get this wrong and there is no error — just pixels from the wrong desktop.

### The token dance, and its two failure modes

`SecureDesktopService` cannot simply start a process on `WinSta0\Winlogon`: it
lives in session 0 and that window station belongs to the interactive session. So
it duplicates its own SYSTEM token, calls
`SetTokenInformation(TokenSessionId)` to move the copy into the console session —
which works only because the caller is SYSTEM with `SE_TCB_NAME` — and passes the
result to `CreateProcessAsUser`. Per PLAN 5.3:

- `CreateProcessAsUser` → **5 (access denied)**: the wrong token was duplicated,
  or the session id was never set.
- a **desktop error**: `lpDesktop` is missing its window-station prefix. It must
  be `WinSta0\Winlogon`, never bare `Winlogon`.

### Credential handling, and the one gap that remains

The password is zeroed on every path that this project controls: it is copied out
of the message into a `char[]`, copied once more into unmanaged memory for
`CreateProcessWithLogonW`, and both are overwritten in a `finally` — the unmanaged
block **before** it is freed, because freed heap is not cleared.

The gap, recorded rather than hidden: `System.Text.Json` has already materialised
the password as an immutable `string` before any of that runs, and a .NET string
cannot be overwritten. So a copy stays reachable until the GC collects it, and
could appear in a crash dump taken meanwhile. Closing it needs a hand-written
reader that never builds the string — real work, and beyond this POC. PLAN 5.2c
rule 4 says "where the API allows", which is exactly this boundary.

The relay can also see the plaintext in transit; PLAN 5.2c rule 3 names that as a
known POC limitation, and the fix past a POC is end-to-end encrypting the payload
to a key the applet generates at session start.

### Nothing survives — by two independent routes

CLAUDE.md constraint #4 is the one this phase could most easily break, so it has
two mechanisms that do not share a failure mode:

1. **The applet uninstalls it.** `Program.Teardown()` → `ElevationManager.Shutdown()`
   → `ServiceControl.Uninstall()`, on every exit path including the crash handlers.
2. **The service uninstalls itself.** Its watchdog polls for the applet's named
   pipe — which exists for exactly as long as the applet does — and after 60
   seconds of absence stops, `sc delete`s itself and removes `%ProgramData%`. This
   is the path that covers the applet being killed.

The staged files cannot be deleted from inside the service (its own .exe is one of
them), so a detached `cmd.exe` does it a moment after the process exits.
Deliberately **not** `MOVEFILE_DELAY_UNTIL_REBOOT`: that would leave a SYSTEM
service binary in `%ProgramData%` for as long as the machine stays up, which is
the persistence constraint #4 forbids.

### Ctrl+Alt+Del is not a key chord

`SendInput` cannot produce a Secure Attention Sequence — that reservation is the
point of it, and is why the SAS is trustworthy. So `agent.input` gained a third
kind, `sas`, which the applet routes to the helper's `SendSAS()` rather than
turning into three key events that would do something else entirely. The console's
button stays disabled until `host.elevated { ok:true }` arrives.

### The pipe carries two kinds of client

Both the service and the current helper connect to the same per-session pipe, and
each announces itself with a `TagHello` frame. Input and SAS go to whichever
helper owns the active desktop; `asSystem` scripts go to the service, which is the
only process that is both SYSTEM and alive for the whole session. The ACL admits
LocalSystem and the session's own user and nobody else — a world-writable pipe
carrying input events into a SYSTEM process is a local privilege-escalation hole.

`NamedPipeServerStreamAcl.Create` and `PipeSecurity` are in-box for
`net8.0-windows`; the `System.IO.Pipes.AccessControl` package the Phase 0 scaffold
expected is not needed.

### Why the service is hand-rolled

`ServiceBase` lives in a NuGet package this project does not otherwise need, while
every other Win32 surface here is already reached by P/Invoke. `ServiceHost.cs`
is `StartServiceCtrlDispatcher` + `RegisterServiceCtrlHandlerEx` +
`SetServiceStatus` and nothing else. The contract to remember: report RUNNING
quickly, and report STOPPED **before** `ServiceMain` returns, or the SCM waits out
its timeout and kills the process — leaving the registration behind, which is the
one outcome this phase must never produce.

### What the Linux side can and cannot prove

`tests/browser/14-phase5-elevation.mjs` (24 checks) covers the console half: the
panel's lifecycle, that interactive mode tells the agent the prompt is on the
*user's* screen, that the password is sent once and cleared immediately and is in
neither `localStorage` nor `sessionStorage` nor the DOM, that success enables
Ctrl+Alt+Del and that it sends `kind:"sas"` rather than a chord, and that
`host.desktopChanged` drives the banner. `tests/dotnet/ElevationErrorTests`
(9 checks) covers the Win32 error mapping — the difference between "wrong
password" and "this account cannot log on interactively" is what decides whether
the agent retries or switches accounts.

That block runs with `ALLOW_INSECURE_DEV=1`, and only because over plain `ws://`
the relay hard-refuses a credential elevation and the frame could not be observed
at all. The refusal itself is asserted without the flag in `ws/05`.

Nothing above touches Windows. MT-06 is the test that matters.

### The Phase 5 review, and the two findings worth remembering

The phase was reviewed line by line before it was committed. Eleven defects; the
full list is in `CHANGELOG.md`. Two are worth carrying forward because they are
both *classes* of mistake this codebase is prone to.

**A safety mechanism that could never run.** `PipeChannel.Exists` opened
`@"\.\pipe"` — which C# reads as a path relative to the current drive — instead
of `@"\\.\pipe\"`. Every call threw. `SafeExists` catches and returns "present",
on the reasoning that an unreadable namespace is not proof the applet has gone,
so the watchdog concluded the applet was alive forever and the second uninstall
route was dead code. It compiled, it reviewed cleanly at a glance, and only
Windows could have caught it at runtime — which is the one thing this project
cannot do to itself.

The lesson generalised into `tests/source/15-windows-invariants.mjs`: for the
Windows half, assert the properties a compiler cannot see. That file is cheap,
it is ugly, and it would have caught this.

**Inherited permissions on a directory holding a SYSTEM binary.** `%ProgramData%`
grants any authenticated user the right to create subdirectories, and
`CREATOR OWNER` inherits full control to whoever creates one. So a standard user
could pre-create `%ProgramData%\HelpdeskAnywhere\`, own it, wait for a support
session, and swap the binary in the moment before it is registered as a
LocalSystem service — a local privilege escalation delivered by the support tool
itself. `Directory.CreateDirectory` gives no hint of this; the ACL is invisible
in the code that matters.

It now deletes any existing directory rather than reusing one it cannot vouch
for, and creates the replacement *with* a protected DACL rather than creating it
and securing it afterwards — those two steps have a window in between.

### Session end no longer waits a minute

Worth knowing when reading the teardown path: the applet runs as the end user and
therefore **cannot normally delete the LocalSystem service it caused to exist** —
only the short-lived installer child was ever elevated. The original design left
ordinary session end to the watchdog, i.e. up to 60 seconds with a SYSTEM service
still registered after the user clicked End Session.

The applet now asks over the pipe (`TagShutdown` → `ServiceLink` →
`Program.SessionOver`) and the service removes itself immediately. The watchdog
stays exactly as it was, for the case the request can never cover: the applet
being killed outright. `ServiceControl.Uninstall()` also stays, for the case
where the applet does happen to hold the rights. Three routes, one destination,
no shared failure mode.

---

## Cross-phase review, 2026-09-04

Run after Phase 5 landed, over phases 1–7. Seven findings, **none of them in
Phase 5** — which had just been reviewed line by line. Worth remembering as a
calibration: a fresh review of new code finds different things than a review of
the seams that new code moved.

### The two that mattered

**A comment that had become a lie.** `AppletContext.Finish` opened with "Capture
stops before anything else: no frame may outlive the session", and then stopped
the streamer fourth — after an SCM stop-and-wait (up to ten seconds) and a
process-tree kill. The comment described the *intent* accurately and the code had
drifted from it as steps were prepended by later phases; each addition looked
locally correct, and each pushed the streamer one place further down.

That is worth generalising: a teardown sequence is one of the few places where
the *order* is the requirement, and comments do not enforce order. There are now
three source invariants that do.

**A race whose blast radius was the wrong thing.** `InputInjector`'s held-key
`HashSet` is written from the UI thread and read from `Program.Teardown`, which
runs on whatever thread crashed. The race itself is ordinary. What made it worth
finding is where the throw would land: every teardown step was a bare statement,
so an exception in "release held keys" skipped "remove the elevated service".

The fix is not just the lock. Each step is now independently guarded, because
each step un-tracks its object *before* disposing it — so a throw half-way left
the object neither torn down by `Finish` nor reachable from `Program.Teardown`'s
backstop. Two mechanisms that both look like belt and braces can share a failure
mode if you do not check.

### The TLS path never needed the token

`scripts/verify-tls-local.sh` runs the real `caddy` service from the real
`Caddyfile` with `PUBLIC_HOST=localhost`, which makes Caddy sign a certificate
from its own internal CA. Nine checks pass, covering everything the permanent
deployment does except who signed the certificate.

The whole `tls` profile had been sitting untested behind an assumption that
testing it required a DuckDNS hostname. It required a DuckDNS hostname to test
*ACME*, which is one line of the config.

One detail found writing it, which will otherwise cost somebody an afternoon:
a `curl` upgrade probe against an HTTPS endpoint must pass `--http1.1`. HTTP/2
has no `Upgrade` header, so over an ALPN-negotiated h2 connection the request is
an ordinary GET and comes back 401 from the console auth — which looks exactly
like "the proxy is eating my WebSocket". Browsers open WebSockets over HTTP/1.1
regardless of what the page was loaded over, so real clients never see this.

### Settings that existed but could not be set

`CREATE_ATTEMPTS_PER_MINUTE`, `MAX_LIVE_SESSIONS` and `ALLOWED_ORIGINS` were in
`config.ts` and absent from `docker-compose.yml`. Compose passes an **explicit**
environment block, so a key not named there never reaches the container, whatever
`.env` says. Two of the three had been added by the previous security review and
were pinned to their defaults in every deployment since.

Worth a standing check: after adding an env var to `config.ts`, grep
`docker-compose.yml` and `.env.example` for it before calling it configurable.

---

## First external deployment — ngrok (2026-09-04)

The stack went up behind an ngrok tunnel and `verify-deployment.sh` reported
14 passed, 2 failed. Both failures were in the harness, not the server; a third
problem, which no check was looking at, was real.

### The two failures: curl negotiated HTTP/2, which cannot carry an upgrade

Symptom: the `/ws` upgrade check got `HTTP/2 401` instead of `101`, and the
foreign-Origin check got `HTTP/2 401` instead of `403`. A 401 on the *relay*
reads alarmingly — it says the applet's socket is about to be asked for console
credentials it has never had and must never need.

It was not. `Connection` and `Upgrade` are hop-by-hop headers, and HTTP/2 forbids
them outright (RFC 9113 §8.2.2). curl offers h2 by ALPN, ngrok's edge accepts, and
curl then silently drops the two headers it cannot legally send. What reached the
app was a bare `GET /ws` — not an upgrade, so `ws` (attached to the HTTP server's
`upgrade` event) never saw it, so it fell through Express to `consoleAuth`, which
answered 401 because `/ws` is not a public path. The foreign-Origin check failed
for the same reason one step earlier: with no upgrade there is no `verifyClient`
call, so nothing ever evaluated the Origin.

Forcing `--http1.1` on both checks — the protocol every real client here uses for
the handshake, browsers and the applet's `ClientWebSocket` alike — gives 101 and
403 as designed. `verify-tls-local.sh` had already learned this against Caddy;
`verify-deployment.sh` had not.

**Nothing in the application was weakened, and nothing needed to be.** Verified
against the live tunnel: no Origin → 101, same-origin → 101, foreign origin →
403 with `Forbidden origin`.

### What was genuinely wrong: a 401 that told the operator a lie

The server was right to refuse that bare GET and wrong about how. A plain
`GET /ws` now answers **426 Upgrade Required** with an `Upgrade: websocket`
header, ahead of `consoleAuth`. This is not a security relaxation — a
non-upgrade GET was never going to reach the relay either way — it is the
difference between a deployment that says "your proxy stripped the upgrade" and
one that says "authentication required" and sends the operator to read auth code
for an hour. It discloses nothing: `/ws` is already named in `portal.js`, in the
join page's CSP `connect-src`, and in the URL baked into every applet.

### `PUBLIC_HOST` was still `localhost:8080` on a public tunnel

`/healthz` reported `publicHost: localhost:8080` while the deployment was live at
`https://paternity-cannot-removal.ngrok-free.dev`. Cause: the app must start
*before* the tunnel exists — ngrok forwards to `app:8080` — so it starts with
whatever `.env` already said, and with no reserved `NGROK_URL` that value is
necessarily stale. Nothing reconciled it afterwards.

It looks cosmetic and is not. `PUBLIC_HOST` is:

- what `/healthz` reports and what the startup log prints as the join link;
- the URL `build-windows.sh` bakes into the `.exe` when `SERVER_URL` is not
  passed — the failure mode being an applet that dials `wss://localhost:8080/ws`
  on the end user's machine and cannot say why it will not connect;
- one of the two hosts `originAllowed()` accepts;
- half of the `looksPublic` test that makes `ALLOW_INSECURE_DEV` fatal on a real
  deployment. With `PUBLIC_HOST=localhost` that test leans entirely on
  `TRUST_PROXY`.

The console itself was never affected: `portal.js` builds both the join link and
the `/ws` URL from `location`, never from server config. And the Origin policy
held for the same reason it looked fine — ngrok forwards the original `Host`, so
the same-origin branch matched before the `publicHost` branch was reached.

`deploy-ngrok.sh` now writes the discovered hostname back with a new `set_env`
helper (`scripts/lib/envfile.sh`) and restarts the app before verifying. The
helper rewrites `.env` through a temp file created `600` in the same directory:
that file holds the console password and the ngrok authtoken, and must never be
briefly world-readable or briefly truncated.

### Running `verify-tls-local.sh` takes a live ngrok deployment down

Both compose files define the same `app` service, so the TLS check recreates it
under `PUBLIC_HOST=localhost` and its cleanup `down` removes it — leaving the
ngrok container up and the tunnel answering `ERR_NGROK_8012` from the edge.
Expected, not a bug: it is a local verification of a different topology. Bring
the deployment back with `docker compose --profile ngrok up -d`, which does not
restart ngrok and so keeps the same URL.
