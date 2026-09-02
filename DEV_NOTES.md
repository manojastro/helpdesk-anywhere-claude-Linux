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

## Test environment

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
