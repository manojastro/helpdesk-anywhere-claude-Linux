#!/usr/bin/env bash
# Convenience entry point: ./scripts/run-tests.sh [args…] → tests/run-all.sh
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tests/run-all.sh" "$@"
