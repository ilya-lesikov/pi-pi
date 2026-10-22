#!/usr/bin/env bash
# Tags a release of the bb plugin in bb/. bb installs and updates it from this
# repository's bb-plugin-vX.Y.Z tags:
#
#   bb plugin install git:github.com/ilya-lesikov/pi-pi@^0.1 --tag-prefix bb-plugin- --plugin pi-pi
#
# Bump "version" in bb/package.json and commit it first; the tag is made from
# that version, so the two cannot disagree. Before tagging, the committed tree
# is built the way bb builds a git install (a fresh clone, production
# dependencies only), which catches a dependency the checkout has but a user's
# install would not. Pushing the tag is left to you.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p 'require("./bb/package.json").version')"
TAG="bb-plugin-v${VERSION}"

if [ -n "$(git status --porcelain -- bb .bb)" ]; then
  echo "ERROR: bb/ or .bb/ has uncommitted changes; the tag would not include them." >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "ERROR: ${TAG} already exists; bump \"version\" in bb/package.json." >&2
  exit 1
fi

CLONE="$(mktemp -d)"
trap 'rm -rf "$CLONE"' EXIT
echo "▶ building ${TAG} from a fresh clone of HEAD"
git clone -q . "$CLONE"
(
  cd "$CLONE/bb"
  npm install --prefix . --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund >/dev/null
  bb plugin build . >/dev/null
)

git tag -a "$TAG" -m "bb plugin ${VERSION}"
echo "✓ tagged ${TAG} at $(git rev-parse --short HEAD)"
echo "  publish it with: git push origin HEAD ${TAG}"
