#!/usr/bin/env bash
# Release-layout smoke test: pack the root package, install the tarball into a throwaway
# directory OUTSIDE this checkout, and verify the shipped extension artifact resolves its
# runtime imports from the installed tree alone.
#
# Why this exists: the root `npm test` excludes 3p/** and the vendored suites run inside
# 3p/*/node_modules, so a bare import that a vendored extension needs but the root package
# forgets to declare is invisible in the dev checkout (its node_modules still has the package).
# It only surfaces after a clean `npm install` by a consumer — exactly the croner/nanoid
# regression this guards against. Resolving bare specifiers from the installed package tree is
# the only shape that reproduces that failure.
#
# Registry access is required (npm install of the tarball fetches deps, runs the root
# postinstall, and npm v7+ auto-installs peerDependencies). Offline CI: warm the npm cache and
# export a --prefer-offline-friendly registry mirror.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

TMPDIR_SMOKE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_SMOKE"' EXIT

echo "▶ packing root package"
PACK_JSON="$(npm pack --json --pack-destination "$TMPDIR_SMOKE" 2>/dev/null)"
TARBALL="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);process.stdout.write(a[0].filename)})' <<<"$PACK_JSON")"
if [ -z "$TARBALL" ] || [ ! -f "$TMPDIR_SMOKE/$TARBALL" ]; then
  echo "ERROR: npm pack did not produce a tarball (got: '$TARBALL')." >&2
  exit 1
fi
echo "  tarball: $TARBALL"

INSTALL_DIR="$TMPDIR_SMOKE/install"
mkdir -p "$INSTALL_DIR"
( cd "$INSTALL_DIR" && npm init -y >/dev/null 2>&1 )

echo "▶ installing tarball into a clean consumer directory"
if ! ( cd "$INSTALL_DIR" && npm install "$TMPDIR_SMOKE/$TARBALL" --no-audit --no-fund 2>&1 ); then
  echo "ERROR: installing the packed tarball failed." >&2
  exit 1
fi

PKG_NAME="$(node -e 'process.stdout.write(require("./package.json").name)')"
PKG_DIR="$INSTALL_DIR/node_modules/$PKG_NAME"
if [ ! -d "$PKG_DIR" ]; then
  echo "ERROR: installed package not found at $PKG_DIR" >&2
  exit 1
fi

# Run the resolution check from a helper placed INSIDE the installed package, so bare-specifier
# resolution provably walks the artifact's own node_modules hierarchy (not this checkout's).
CHECK="$PKG_DIR/__smoke-resolve.mjs"
cp "$ROOT/scripts/lib/smoke-resolve.mjs" "$CHECK"

echo "▶ resolving shipped extension runtime imports from the install tree"
( cd "$PKG_DIR" && node "$CHECK" )
STATUS=$?

if [ $STATUS -ne 0 ]; then
  echo "✗ package smoke test FAILED" >&2
  exit $STATUS
fi
echo "✓ package smoke test passed"
