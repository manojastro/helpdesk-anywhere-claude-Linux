#!/usr/bin/env bash
# Audit-log verification (PLAN 1.6, CLAUDE.md constraints #5 and #6).
#
#   ./scripts/verify-audit.sh [audit-dir]
#
# Two jobs. First, that the log is well-formed and complete enough to answer
# "what happened in this session". Second — the one that actually matters — that
# it contains no credential. Constraint #6 says an admin password must never
# reach any log, and Phase 5's acceptance test greps every log for it; this makes
# that check runnable at any time instead of once.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
audit_dir="${1:-$repo_root/audit}"

pass=0; fail=0
check() {
  local name="$1" ok="$2" detail="${3:-}"
  if [[ "$ok" == "1" ]]; then
    pass=$((pass + 1)); printf '  PASS  %s%s\n' "$name" "${detail:+  — $detail}"
  else
    fail=$((fail + 1)); printf '  FAIL  %s%s\n' "$name" "${detail:+  — $detail}"
  fi
}

printf '\n=== Audit verification — %s ===\n\n' "$audit_dir"

if [[ ! -d "$audit_dir" ]]; then
  printf '  FAIL  audit directory does not exist\n\n'
  exit 1
fi

shopt -s nullglob
logs=("$audit_dir"/*.jsonl)
shopt -u nullglob

if [[ ${#logs[@]} -eq 0 ]]; then
  printf '  NOTE  no audit files yet — run a session first\n\n'
  exit 0
fi
check "audit files present" 1 "${#logs[@]} file(s)"

total=0; bad=0
for f in "${logs[@]}"; do
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    total=$((total + 1))
    printf '%s' "$line" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const o=JSON.parse(d);process.exit(o.ts&&o.event?0:1)}catch{process.exit(1)}})' \
      || bad=$((bad + 1))
  done < "$f"
done
check "every line is valid JSON with a timestamp and an event" "$([[ $bad -eq 0 ]] && echo 1 || echo 0)" \
  "$total records, $bad malformed"

# --- the constraint #6 check ------------------------------------------------
# Any of these appearing as a KEY would mean a credential reached the log. The
# relay forwards elevation frames verbatim and audits only mode/domain/username,
# so a hit here is a real regression, not a false positive.
forbidden='"password"|"passwd"|"pwd"|"secret"|"token"|"credential"'
if grep -rEl "$forbidden" "$audit_dir" >/dev/null 2>&1; then
  check "no credential-shaped field in the audit log (constraint #6)" 0 \
    "$(grep -rEo "$forbidden" "$audit_dir" | sort -u | tr '\n' ' ')"
else
  check "no credential-shaped field in the audit log (constraint #6)" 1
fi

# If a test password is exported, prove that exact string is nowhere in any log.
if [[ -n "${TEST_ADMIN_PASSWORD:-}" ]]; then
  if grep -rqF "$TEST_ADMIN_PASSWORD" "$audit_dir" 2>/dev/null; then
    check "TEST_ADMIN_PASSWORD does not appear in any log" 0 "FOUND — this is a serious leak"
  else
    check "TEST_ADMIN_PASSWORD does not appear in any log" 1
  fi
fi

# --- completeness -----------------------------------------------------------
summary="$(cat "${logs[@]}" | node -e '
let d = "";
process.stdin.on("data", (c) => (d += c)).on("end", () => {
  const events = d.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const counts = {};
  for (const e of events) counts[e.event] = (counts[e.event] ?? 0) + 1;
  const codes = new Set(events.map((e) => e.code).filter(Boolean));
  console.log(JSON.stringify({ counts, sessions: codes.size }));
});')"
printf '  INFO  %s\n' "$summary"

created="$(printf '%s' "$summary" | grep -c 'session.created' || true)"
consent="$(printf '%s' "$summary" | grep -c 'session.consent' || true)"
check "session lifecycle events are recorded" "$([[ "$created" -ge 1 ]] && echo 1 || echo 0)" \
  "created events present"
[[ "$consent" -ge 1 ]] && check "consent decisions are recorded (constraint #5)" 1 \
  || printf '  NOTE  no consent events yet — no session has reached the consent step\n'

printf '\n  %d passed, %d failed\n\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
