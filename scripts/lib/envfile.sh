# Shared .env handling for the deploy and verify scripts. Source it, do not run it.
#
# Three rules live here, in one place because they were previously in four:
#
#  1. A .env is DATA, not a shell script. `source .env` executes it, and an
#     unquoted value containing a space or a backtick becomes a command. Read
#     keys out with sed instead.
#  2. The file holds the console password and the ngrok authtoken, so it is
#     chmod 600 whatever the person who created it did (security review,
#     2026-09-03).
#  3. A placeholder is not a value. `.env.example` ships with obvious ones, and a
#     deployment that starts with `CONSOLE_PASSWORD=changeme` is worse than one
#     that refuses to start, because it looks like it worked.

# read_env <KEY> — the last assignment of KEY in ./.env, unquoted. Empty if absent.
read_env() {
  [[ -f .env ]] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env \
    | tail -n1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# harden_env — make .env owner-readable only.
harden_env() {
  [[ -f .env ]] || return 0
  local mode; mode="$(stat -c '%a' .env 2>/dev/null || echo '')"
  if [[ -n "$mode" && "$mode" != "600" ]]; then
    chmod 600 .env && echo "note: tightened .env permissions from $mode to 600"
  fi
}

# looks_placeholder <value> — true for something nobody meant as a real secret.
# Deliberately conservative: it must never reject a real password, so it matches
# only the shapes that come from copying .env.example and not editing it.
looks_placeholder() {
  local value="${1:-}"
  [[ -z "$value" ]] && return 0
  shopt -s nocasematch
  local hit=1
  case "$value" in
    *placeholder*|*changeme*|*change-me*|*your-*|*yourtoken*|*example*|\<*\>|xxx*|*todo*) hit=0 ;;
  esac
  shopt -u nocasematch
  return $hit
}

# set_env <KEY> <VALUE> — write KEY=VALUE into ./.env, replacing an existing
# assignment in place or appending one, and leaving every other line untouched.
#
# Used by deploy-ngrok.sh to record a tunnel hostname that only exists once the
# tunnel is up. The rewrite goes through a temp file created 600 in the same
# directory, so the file is never briefly world-readable and never briefly
# truncated: .env holds the console password and the ngrok authtoken.
set_env() {
  local key="$1" value="$2" tmp
  [[ -f .env ]] || return 1

  tmp="$(mktemp .env.XXXXXX)" || return 1
  chmod 600 "$tmp"

  KEY="$key" VALUE="$value" awk '
    BEGIN { key = ENVIRON["KEY"]; value = ENVIRON["VALUE"]; done = 0 }
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" { print key "=" value; done = 1; next }
    { print }
    END { if (!done) print key "=" value }
  ' .env > "$tmp" || { rm -f "$tmp"; return 1; }

  mv "$tmp" .env
}
