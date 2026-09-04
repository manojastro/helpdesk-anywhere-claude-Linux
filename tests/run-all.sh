#!/usr/bin/env bash
#
# Helpdesk Anywhere regression suite.
#
#   ./tests/run-all.sh              everything that can run here
#   ./tests/run-all.sh --no-browser skip the headless-Chrome blocks
#   ./tests/run-all.sh --only ws    ws | browser | dotnet | source
#
# Nothing here touches Windows. What these suites cover is everything on the
# Linux side of the wire: the relay's state machine, the audit log, the applet's
# exact wire frames replayed against the real server, the console's renderer,
# input capture and script pane, and the three dependency-free C# classes that
# compile for net8.0. See MANUAL_TESTS.md for what only Windows can prove.
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
  # The security block is the one that MUST run against an authenticated console,
  # whatever the rest of the run is configured for, and with a create limit low
  # enough to reach in a few seconds.
  server_reset_state
  CONSOLE_PASSWORD="${CONSOLE_PASSWORD:-review-only-Pa55}" server_start CREATE_ATTEMPTS_PER_MINUTE=3 \
    && CONSOLE_PASSWORD="${CONSOLE_PASSWORD:-review-only-Pa55}" \
       run "ws/07 security — auth bypass, origin, create flood" node "$REPO/tests/ws/07-security.mjs"
fi

# -------------------------------------------------------------- source block
# The Windows half compiles here and runs nowhere here. These are the invariants
# a compiler cannot see: no auto-start service, a pipe path that resolves, a
# password that reaches no log, an ACL that is not inherited. Cheap, and each one
# is a bug that shipped or nearly did.
if [[ -z "$ONLY" || "$ONLY" == "source" ]]; then
  run "source — windows invariants (constraints #2, #4, #6)" \
    node "$REPO/tests/source/15-windows-invariants.mjs"
fi

# -------------------------------------------------------------- dotnet block
if [[ -z "$ONLY" || "$ONLY" == "dotnet" ]]; then
  if command -v dotnet >/dev/null; then
    for proj in ConfigTests WireTests TileTests KeyMapTests StagingTests ElevationErrorTests; do
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
