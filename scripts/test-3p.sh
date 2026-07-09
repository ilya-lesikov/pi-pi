#!/usr/bin/env bash
# Aggregates the test suites of the vendored 3p/ extensions, each run with its OWN native runner
# (vitest for pi-subagents/pi-tasks, bun for pi-lsp/pi-ask-user/pi-plannotator). The root
# `npm test` excludes 3p/**, so without this the fork-delta tests never gate CI.
#
# Exit non-zero if any package's suite fails. Runs every package even if an earlier one fails, so
# one invocation reports all breakage.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "ERROR: 'bun' is not on PATH — pi-lsp, pi-ask-user and pi-plannotator gate on it." >&2
  echo "Install bun (https://bun.sh) and re-run, or run the vitest 3p suites individually." >&2
  exit 127
fi

failures=()

run() {
  local name="$1"; shift
  local dir="$1"; shift
  echo ""
  echo "──────────────────────────────────────────────"
  echo "▶ 3p/$name  ($*)"
  echo "──────────────────────────────────────────────"
  ( cd "$ROOT/3p/$dir" && "$@" )
  if [ $? -ne 0 ]; then
    failures+=("$name")
  fi
}

# vitest packages (use the package's own vitest.config.ts via npx vitest run).
run "pi-subagents" "pi-subagents" npx vitest run
run "pi-tasks"     "pi-tasks"     npx vitest run

# bun packages. pi-ask-user has no `test` npm script, so invoke `bun test` directly.
run "pi-lsp"      "pi-lsp"      bun test
run "pi-ask-user" "pi-ask-user" bun test

# pi-plannotator: scope explicitly to the shipped pi-extension app + the fork-parity guards.
# Bare `bun test` would reach unshipped upstream workspace packages that need alias setup.
run "pi-plannotator" "pi-plannotator" bun test apps/pi-extension tests/parity

echo ""
echo "──────────────────────────────────────────────"
if [ ${#failures[@]} -eq 0 ]; then
  echo "✓ all 3p suites passed"
  exit 0
fi
echo "✗ 3p suites FAILED: ${failures[*]}"
exit 1
