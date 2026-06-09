#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

bash 3p/pi-plannotator/apps/pi-extension/vendor.sh

PI_EXT_DIR="3p/pi-plannotator/apps/pi-extension"
if [ -f "$PI_EXT_DIR/plannotator.html" ] && [ -f "$PI_EXT_DIR/review-editor.html" ]; then
  exit 0
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

npm pack @plannotator/pi-extension --pack-destination "$TMPDIR" --silent 2>/dev/null
tar -xzf "$TMPDIR"/*.tgz -C "$TMPDIR"
cp "$TMPDIR/package/plannotator.html" "$PI_EXT_DIR/plannotator.html"
cp "$TMPDIR/package/review-editor.html" "$PI_EXT_DIR/review-editor.html"
