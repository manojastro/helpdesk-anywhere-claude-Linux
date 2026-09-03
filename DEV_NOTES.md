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

### The Phase 1 acceptance harness is not committed
The harness that drives the acceptance test lives in the session scratchpad rather
than the repo, because `PLAN.md`'s file tree does not include a test directory and
`scripts/mock-host.js` is the tool the plan actually specifies. It exercises: the
happy path, pre-consent frame suppression, wrong code, code reuse, code expiry, the
6-attempt rate limit, consent decline, role-handshake violations, peer-drop teardown,
audit completeness, and the credential sentinel. Worth promoting into the repo if
these become regression tests for later phases.
