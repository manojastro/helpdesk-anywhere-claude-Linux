#!/usr/bin/env bash
#
# Install the headless-Chrome toolchain the browser suites need, into a cache
# directory OUTSIDE the repo (~/.cache/helpdesk-anywhere by default).
#
# Neither Puppeteer nor Chrome is a dependency of the product — the server ships
# without them — so neither belongs in server/package.json or in the tree.
#
# Two Ubuntu 24.04 snags this works around (DEV_NOTES.md → Test environment):
#   1. `npx puppeteer browsers install chrome` fails with
#      "IncompleteInstallationError: All providers failed", while the same zip
#      downloads fine with curl. So we fetch it directly.
#   2. The extracted binary needs libraries a server install does not have.
set -euo pipefail

CACHE="${HDA_TEST_CACHE:-$HOME/.cache/helpdesk-anywhere}"
CHROME_VERSION="${CHROME_VERSION:-152.0.7385.2}"
mkdir -p "$CACHE"

if [[ ! -x "$CACHE/chrome/chrome-linux64/chrome" ]]; then
  echo "→ downloading Chrome for Testing $CHROME_VERSION"
  url="https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-linux64.zip"
  tmp="$(mktemp -d)"
  curl -fsSL "$url" -o "$tmp/chrome.zip"
  mkdir -p "$CACHE/chrome"
  unzip -q "$tmp/chrome.zip" -d "$CACHE/chrome"
  rm -rf "$tmp"
else
  echo "→ Chrome already present at $CACHE/chrome"
fi

if [[ ! -d "$CACHE/puppeteer/node_modules/puppeteer" ]]; then
  echo "→ installing puppeteer (library only; it will not download its own browser)"
  mkdir -p "$CACHE/puppeteer"
  cat > "$CACHE/puppeteer/package.json" <<'JSON'
{ "name": "hda-test-browser", "private": true, "dependencies": { "puppeteer": "^25.9.0" } }
JSON
  ( cd "$CACHE/puppeteer" && PUPPETEER_SKIP_DOWNLOAD=1 npm install --no-audit --no-fund )
else
  echo "→ puppeteer already present at $CACHE/puppeteer"
fi

if ! "$CACHE/chrome/chrome-linux64/chrome" --version >/dev/null 2>&1; then
  cat >&2 <<'MSG'

Chrome is installed but will not start. On a server install it needs:

  sudo apt-get install -y libatk1.0-0t64 libatk-bridge2.0-0t64 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 libatspi2.0-0t64 \
    libcups2t64 libnss3 libnspr4 libxkbcommon0 libpango-1.0-0 libcairo2

MSG
  exit 1
fi

echo
echo "✔ browser toolchain ready — ./tests/run-all.sh will find it automatically"
