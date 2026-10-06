#!/usr/bin/env bash
#
# Helpdesk Anywhere regression suite.
#
#   ./tests/run-all.sh              everything that can run here
#   ./tests/run-all.sh --no-browser skip the headless-Chrome blocks
#   ./tests/run-all.sh --only ws    ws | unit | api | browser | dotnet | source
#
# Nothing here touches Windows. What these suites cover is everything on the
# Linux side of the wire: the relay's state machine, the audit log, the applet's
# exact wire frames replayed against the real server, the console's renderer,
# input capture and script pane, the three dependency-free C# classes that
# compile for net8.0, and the application manifest embedded in the built .exe. See MANUAL_TESTS.md for what only Windows can prove.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export REPO
source "$REPO/tests/lib/server.sh"

ONLY=""; WANT_BROWSER=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-browser) WANT_BROWSER=0 ;;
    --only) ONLY="$2"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

pass=0; fail=0; skip=0
declare -a FAILED=()

blue()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }

# run <label> <command...>
run() {
  local label="$1"; shift
  blue "── $label ─────────────────────────────────────────"
  if "$@"; then
    green "   ✔ $label"
    ((pass++))
  else
    red   "   ✘ $label"
    FAILED+=("$label"); ((fail++))
  fi
}

# ---------------------------------------------------------------- preflight
if [[ ! -f "$REPO/server/dist/index.js" ]]; then
  echo "server/dist is missing — building…"
  npm --prefix "$REPO/server" run build || exit 1
fi

# PostgreSQL for the server (a throwaway Docker container unless
# HDA_TEST_DATABASE_URL / HDA_TEST_PG_ADMIN_URL point elsewhere).
db_ensure || { red "PostgreSQL unavailable — cannot run server blocks"; exit 1; }
server_reset_state
trap server_stop EXIT

# ------------------------------------------------------------------ ws block
if [[ -z "$ONLY" || "$ONLY" == "ws" ]]; then
  # Each block gets a fresh server: the rate limiter and the code TTL are
  # process state, and a shared server makes results order-dependent.
  server_start                       && run "ws/01 phase 1 — happy path, burn, teardown" node "$REPO/tests/ws/01-phase1-happy.mjs"
  server_start                       && run "ws/02 phase 1 — join rate limiting"          node "$REPO/tests/ws/02-phase1-ratelimit.mjs"
  server_start SESSION_CODE_TTL_MS=1500 && run "ws/03 phase 1 — code expiry"              node "$REPO/tests/ws/03-phase1-expiry.mjs"
  server_start                       && run "ws/04 phase 1 — decline, state machine"      node "$REPO/tests/ws/04-phase1-protocol.mjs"
  server_reset_state
  server_start                       && run "ws/05 phase 1 — audit log, credentials"      node "$REPO/tests/ws/05-phase1-audit.mjs"
  server_start                       && run "ws/06 phase 2 — applet wire replay"          node "$REPO/tests/ws/06-applet-wire.mjs"
  # Feature Batch 1. Hold is only a hold if the RELAY refuses the actions, so this
  # block drives the wire directly rather than through the console.
  server_reset_state
  server_start                       && run "ws/08 hold — relay enforcement, audit"       node "$REPO/tests/ws/08-hold.mjs"
  # Feature Batch 2. Chat, Send URL and notes at the relay — session isolation,
  # sender-identity spoofing, XSS-as-plain-data, rate limits, dedup, and that
  # none of it is gated by Hold.
  server_reset_state
  server_start                       && run "ws/09 chat, send url, notes"                 node "$REPO/tests/ws/09-chat.mjs"
  # Multi-session: four concurrent sessions per technician, the fifth refused,
  # the race for the last slot, no cross-session traffic, technician reconnect
  # (grace, ownership, token, catch-up), keyframe-only background video.
  server_reset_state
  server_start JOIN_ATTEMPTS_PER_MINUTE=200 CREATE_ATTEMPTS_PER_MINUTE=200 \
    && run "ws/10 multi-session — limit, race, isolation, resume" node "$REPO/tests/ws/10-multi-session.mjs" main
  server_reset_state
  server_start JOIN_ATTEMPTS_PER_MINUTE=200 AGENT_RECONNECT_GRACE_MS=1500 \
    && run "ws/10b multi-session — reconnect grace expiry" node "$REPO/tests/ws/10-multi-session.mjs" expiry
  server_reset_state
  server_start JOIN_ATTEMPTS_PER_MINUTE=200 RESUME_ATTEMPTS_PER_MINUTE=3 \
    && run "ws/10c multi-session — resume rate limit" node "$REPO/tests/ws/10-multi-session.mjs" resume-limit
  # Security & reliability audit 2026-10-05 (docs/audit/): console-access and
  # sign-out revocation, message allow-list, bounded host fields, per-side chat
  # limits, anonymous-socket cap, video backpressure, TLS on both legs.
  server_reset_state
  server_start JOIN_ATTEMPTS_PER_MINUTE=200 CREATE_ATTEMPTS_PER_MINUTE=200 \
    && run "ws/11 audit 2026-10-05 — revocation, allow-list, limits, backpressure" node "$REPO/tests/ws/11-audit-fixes.mjs"
  server_reset_state
  server_start JOIN_ATTEMPTS_PER_MINUTE=200 CREATE_ATTEMPTS_PER_MINUTE=200 \
    && run "ws/12 platform 2.0 — lifecycle, health, dashboard" node "$REPO/tests/ws/12-lifecycle.mjs"
  server_reset_state
  server_start JOIN_ATTEMPTS_PER_MINUTE=200 CREATE_ATTEMPTS_PER_MINUTE=200 \
    && run "ws/13 platform 2.0 — script library, activity, screenshot record" node "$REPO/tests/ws/13-support-tools.mjs"
  server_reset_state
  server_start JOIN_ATTEMPTS_PER_MINUTE=200 CREATE_ATTEMPTS_PER_MINUTE=200 MAX_FILE_TRANSFER_BYTES=300000 MAX_TRANSFERS_PER_SESSION=2 \
    && run "ws/14 platform 2.0 — files, clipboard, sysinfo, cancel" node "$REPO/tests/ws/14-files-clipboard.mjs"
  server_reset_state
  server_start JOIN_ATTEMPTS_PER_MINUTE=200 CREATE_ATTEMPTS_PER_MINUTE=200 \
    && run "ws/15 platform 2.0 — customer reconnect" node "$REPO/tests/ws/15-customer-reconnect.mjs" main
  server_reset_state
  server_start JOIN_ATTEMPTS_PER_MINUTE=200 HOST_RECONNECT_GRACE_MS=1500 \
    && run "ws/15b platform 2.0 — customer reconnect grace expiry" node "$REPO/tests/ws/15-customer-reconnect.mjs" expiry
  server_reset_state
  server_start JOIN_ATTEMPTS_PER_MINUTE=200 CREATE_ATTEMPTS_PER_MINUTE=200 \
    && run "ws/16 platform 2.0 — session transfer" node "$REPO/tests/ws/16-session-transfer.mjs"
  server_reset_state
  server_start ENABLE_FILE_MANAGER=false ENABLE_SESSION_TRANSFER=false ENABLE_CUSTOMER_RECONNECT=false ENABLE_SCRIPT_LIBRARY=false \
    && run "ws/17 platform 2.0 — feature flags off" node "$REPO/tests/ws/17-feature-flags.mjs"
  server_reset_state
  server_start JOIN_ATTEMPTS_PER_MINUTE=200 CREATE_ATTEMPTS_PER_MINUTE=200 \
    && run "ws/18 platform 2.0 — stream quality and monitors" node "$REPO/tests/ws/18-quality-monitors.mjs"
  if command -v dotnet >/dev/null; then
    server_reset_state
    server_start && run "dotnet/ReconnectTests — the applet's SessionClient reconnects (real relay)" \
      dotnet run --project "$REPO/tests/dotnet/ReconnectTests" -v quiet --nologo
  fi
  server_reset_state
  server_start CREATE_ATTEMPTS_PER_MINUTE=3 \
    && run "ws/07 security — sign-in gate, origin, create flood" node "$REPO/tests/ws/07-security.mjs"
fi

# ----------------------------------------------------------------- api block
# Admin-portal release: identity and access, durable records, crash recovery,
# reports, and the configurations that must never start.
if [[ -z "$ONLY" || "$ONLY" == "unit" ]]; then
  run "unit/40 session lifecycle state machine" node "$REPO/tests/unit/40-lifecycle.mjs"
fi

if [[ -z "$ONLY" || "$ONLY" == "api" ]]; then
  server_reset_state
  server_start && run "api/30 access — bootstrap, pending, roles, portals, limits, suspension, tenancy" \
    node "$REPO/tests/api/30-access.mjs"
  server_reset_state
  server_start && run "api/31 records — timeline, chat save+dedup, notes, storage failure" \
    node "$REPO/tests/api/31-persistence.mjs"
  # The first half kills the server -9 itself, while still holding the session
  # sockets open: nothing gets to close its records, which is exactly what
  # reconciliation is for.
  server_reset_state
  server_start && run "api/32a restart — sessions left open, server killed -9" node "$REPO/tests/api/32-restart.mjs" before
  server_crash
  server_start && run "api/32b restart — reconciled as server_restart, retention applied" node "$REPO/tests/api/32-restart.mjs" after
  # ALLOW_INSECURE_DEV only so a credential-mode elevation really crosses the
  # relay over ws:// — the block then proves its password is in no table, log or report.
  server_reset_state
  server_start ALLOW_INSECURE_DEV=1 && run "api/33 reports — PDF/CSV content, download authorisation, audit" \
    node "$REPO/tests/api/33-reports.mjs"
  server_reset_state
  server_start JOIN_ATTEMPTS_PER_MINUTE=200 CREATE_ATTEMPTS_PER_MINUTE=200 METRICS_TOKEN=test-metrics-token-12345 \
    && run "api/35 platform 2.0 — history, reports, dashboard, SuperAdmin, observability" node "$REPO/tests/api/35-platform-admin.mjs"
  server_stop
  run "api/34 startup — dev sign-in impossible in production, bad config refused" node "$REPO/tests/api/34-startup.mjs"
fi

# -------------------------------------------------------------- source block
# The Windows half compiles here and runs nowhere here. These are the invariants
# a compiler cannot see: no auto-start service, a pipe path that resolves, a
# password that reaches no log, an ACL that is not inherited. Cheap, and each one
# is a bug that shipped or nearly did.
if [[ -z "$ONLY" || "$ONLY" == "source" ]]; then
  run "source — windows invariants (constraints #2, #4, #6)" \
    node "$REPO/tests/source/15-windows-invariants.mjs"
  # MT-01: a malformed application manifest cross-compiles perfectly and then
  # refuses to start on Windows, in the loader, before Main. Nothing here was
  # looking at it. This block checks the source XML *and* the RT_MANIFEST
  # resource inside the .exe that was actually built.
  run "source — windows application manifest (MT-01)" \
    node "$REPO/tests/source/17-manifest.mjs"
  # MT-06: the secure-desktop chain crosses four processes and two Windows
  # sessions, and its first real failure was one API called in the wrong session.
  # Nothing here can execute it; these assert the facts that made it wrong.
  run "source — secure desktop chain (MT-06)" \
    node "$REPO/tests/source/18-secure-desktop.mjs"
  # The MT-06 diagnostic is a PowerShell script this repository publishes and
  # cannot run. Its first version downloaded fine and would not parse — and
  # parsing it as UTF-8 reported zero errors, so the check has to model how
  # Windows PowerShell 5.1 actually decodes the bytes.
  run "source — MT-06 diagnostic script parses on Windows" \
    node "$REPO/tests/source/19-diagnostic-script.mjs"
  # MT-06 follow-up: the helper launched then exited in a ~300ms loop with its
  # exit code discarded. These lock in the real-exit-code, crash-loop backoff and
  # no-helper-on-Default changes so a regression cannot silently return.
  run "source — desktop helper startup & lifecycle (MT-06)" \
    node "$REPO/tests/source/20-helper-startup.mjs"
  # MT-06 STATE C: UIPI discards a medium-integrity SendInput aimed at the
  # high-integrity window a UAC prompt just launched. These assert the elevated
  # input route, the diagnostics that prove it, and that the working Secure
  # Desktop path is undisturbed.
  run "source — post-UAC elevated input (MT-06 STATE C)" \
    node "$REPO/tests/source/21-elevated-input.mjs"
  # Admin-portal release: privileged Windows components still match the golden
  # checkpoint; credential frames never wait on the database; two separate apps.
  run "source — admin-portal invariants (golden Windows, credentials, two apps)" \
    node "$REPO/tests/source/25-admin-portal-invariants.mjs"
  # Multi-session: race-safe limit, no shared console socket, no stored
  # credentials, and no change under windows/.
  run "source — multi-session invariants" \
    node "$REPO/tests/source/27-multi-session-invariants.mjs"
  # Security audit 2026-10-05: SYSTEM script staging, TLS on both legs,
  # revocation, allow-list, bounds, backpressure — asserted over the source.
  run "source — audit 2026-10-05 invariants" \
    node "$REPO/tests/source/28-audit-invariants.mjs"
  run "source — platform 2.0 phase 1–2 invariants" \
    node "$REPO/tests/source/42-platform-invariants.mjs"
  run "source — platform 2.0 phase 2b applet feature invariants" \
    node "$REPO/tests/source/45-applet-features-invariants.mjs"
fi

# -------------------------------------------------------------- dotnet block
if [[ -z "$ONLY" || "$ONLY" == "dotnet" ]]; then
  if command -v dotnet >/dev/null; then
    for proj in ConfigTests WireTests TileTests KeyMapTests StagingTests ElevationErrorTests PathPolicyTests QualityTests; do
      run "dotnet/$proj" dotnet run --project "$REPO/tests/dotnet/$proj" -v quiet --nologo
    done
    run "dotnet — windows solution builds" \
      dotnet build "$REPO/windows/HelpdeskAnywhere.sln" -c Release -v quiet --nologo
  else
    red "   ⊘ dotnet not on PATH — C# blocks skipped"; ((skip++))
  fi
fi

# ------------------------------------------------------------- browser block
if [[ ( -z "$ONLY" || "$ONLY" == "browser" ) && $WANT_BROWSER -eq 1 ]]; then
  if node -e 'import("./tests/lib/browser.mjs").then(m=>m.launch()).then(b=>b.close()).catch(e=>{console.error(e.message);process.exit(1)})' 2>/dev/null; then
    server_reset_state
    server_start && run "browser/10 phase 1 — two-tab console flow"  node "$REPO/tests/browser/10-phase1-console.mjs"
    server_start && run "browser/11 phase 3 — renderer and counters" node "$REPO/tests/browser/11-phase3-render.mjs"
    server_start && run "browser/12 phase 4 — input capture"         node "$REPO/tests/browser/12-phase4-input.mjs"
    server_reset_state
    server_start && run "browser/13 phase 6 — script pane, audit"    node "$REPO/tests/browser/13-phase6-exec.mjs"
    # ALLOW_INSECURE_DEV only so the credential frame is observable over ws://;
    # the refusal it bypasses is asserted in ws/05 on a server without it.
    server_start ALLOW_INSECURE_DEV=1 \
      && run "browser/14 phase 5 — elevation, banner, SAS"  node "$REPO/tests/browser/14-phase5-elevation.mjs"
    server_reset_state
    server_start && run "browser/16 security — CSP breaks neither page" node "$REPO/tests/browser/16-csp.mjs"
    # No ALLOW_INSECURE_DEV: the block relies on the relay refusing a credential
    # elevation over ws:// to produce a real mid-session error.
    server_start && run "browser/17 console shell — layout, visibility, placeholders" node "$REPO/tests/browser/17-console-shell.mjs"
    # Feature Batch 1. The zoom section drives real clicks at five points of the
    # canvas at every level: a view feature that breaks click mapping is not a
    # feature, and nothing else in the suite would notice.
    server_reset_state
    server_start && run "browser/22 view + hold — fullscreen, zoom, magnifier, hold" node "$REPO/tests/browser/22-view-and-hold.mjs"
    # Feature Batch 2. Keyboard isolation is checked against the REAL host
    # socket through the real relay (like browser/12), not by reading the
    # source and trusting it.
    server_reset_state
    server_start && run "browser/23 chat, send url, replies, notes" node "$REPO/tests/browser/23-chat.mjs"
    # Multi-session: four sessions in one console through the real relay —
    # input only to the selected machine, switch releases held keys, per-session
    # chat/drafts/unread, grid select-before-control, reload resumes, disconnect all.
    server_reset_state
    server_start JOIN_ATTEMPTS_PER_MINUTE=200 CREATE_ATTEMPTS_PER_MINUTE=200 \
      && run "browser/26 multi-session console" node "$REPO/tests/browser/26-multi-session.mjs"
    # Platform 2.0 Phase 1: dashboard, New Session card, header, health, zoom steps.
    server_reset_state
    server_start JOIN_ATTEMPTS_PER_MINUTE=200 CREATE_ATTEMPTS_PER_MINUTE=200 \
      && run "browser/41 technician platform — dashboard, PIN card, health" node "$REPO/tests/browser/41-technician-platform.mjs"
    server_reset_state
    server_start JOIN_ATTEMPTS_PER_MINUTE=200 CREATE_ATTEMPTS_PER_MINUTE=200 \
      && run "browser/43 support tools — scripts, activity, screenshot, isolation" node "$REPO/tests/browser/43-support-tools.mjs"
    server_reset_state
    server_start && run "browser/44 admin portal — script library" node "$REPO/tests/browser/44-admin-scripts.mjs"
    server_reset_state
    server_start JOIN_ATTEMPTS_PER_MINUTE=200 CREATE_ATTEMPTS_PER_MINUTE=200 \
      && run "browser/45 file manager, clipboard, system details, stop" node "$REPO/tests/browser/45-files-clipboard.mjs"
    server_reset_state
    server_start JOIN_ATTEMPTS_PER_MINUTE=200 CREATE_ATTEMPTS_PER_MINUTE=200 \
      && run "browser/46 session transfer between two consoles" node "$REPO/tests/browser/46-session-transfer.mjs"
    server_reset_state
    server_start JOIN_ATTEMPTS_PER_MINUTE=200 CREATE_ATTEMPTS_PER_MINUTE=200 \
      && run "browser/47 stream quality and monitor selection" node "$REPO/tests/browser/47-quality-monitors.mjs"
    # Admin-portal release: the definition-of-done flow through both real UIs.
    server_reset_state
    server_start && run "browser/24 admin portal + console end-to-end" node "$REPO/tests/browser/24-admin-portal.mjs"
  else
    red "   ⊘ headless Chrome unavailable — browser blocks skipped."
    red "     Run tests/setup-browser.sh to install it (see tests/README.md)."
    ((skip++))
  fi
fi

server_stop

echo
echo "═══════════════════════════════════════════════════"
printf 'blocks: %d passed, %d failed' "$pass" "$fail"
[[ $skip -gt 0 ]] && printf ', %d skipped' "$skip"
echo
for f in "${FAILED[@]+"${FAILED[@]}"}"; do red "  failed: $f"; done
echo "═══════════════════════════════════════════════════"
exit $(( fail == 0 ? 0 : 1 ))
