#!/usr/bin/env bash
# Publishes the bb plugin in bb/ to npm, from which bb installs and updates it:
#
#   bb plugin install npm:@ilya-lesikov/bb-plugin-pi-pi
#
# Bump "version" in bb/package.json and commit it first. The package is built
# from a fresh clone of HEAD, so it holds exactly what is committed: bb builds
# no npm plugin's frontend, so the package must carry dist/, and the server
# sources beside it let bb rebuild the server once its SDK moves past dist/.
# The packed tarball is installed the way bb installs it and checked before it
# is published; the commit is then tagged bb-plugin-vX.Y.Z as the record of
# what was released. Pushing the tag is left to you.
#
#   --dry-run   build, pack and check, then stop: nothing is published or tagged
set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

NAME="$(node -p 'require("./bb/package.json").name')"
VERSION="$(node -p 'require("./bb/package.json").version')"
TAG="bb-plugin-v${VERSION}"

if [ -n "$(git status --porcelain -- bb)" ]; then
  echo "ERROR: bb/ has uncommitted changes; the package would not include them." >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "ERROR: ${TAG} already exists; bump \"version\" in bb/package.json." >&2
  exit 1
fi
if [ -n "$(npm view "${NAME}@${VERSION}" version 2>/dev/null)" ]; then
  echo "ERROR: ${NAME}@${VERSION} is already on npm; bump \"version\" in bb/package.json." >&2
  exit 1
fi

# bb's command line, not the desktop app: the AppImage on PATH as `bb` takes a
# command, does nothing with it, and exits 0. bb sets BB_CLI in its threads and
# writes a launcher for its command line into its data directory.
BB=""
for candidate in "${BB_CLI:-}" "${BB_DATA_DIR:-$HOME/.bb}/bin/bb" "$(command -v bb || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && "$candidate" --version 2>/dev/null | grep -Eq '^[0-9]+\.[0-9]+'; then
    BB="$candidate"
    break
  fi
done
if [ -z "$BB" ]; then
  echo "ERROR: bb's command line not found: set BB_CLI to it (bb writes one to ~/.bb/bin/bb)." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "▶ building ${NAME}@${VERSION} from a fresh clone of HEAD"
git clone -q . "$WORK/repo"
(
  cd "$WORK/repo/bb"
  npm ci --ignore-scripts --no-audit --no-fund >/dev/null
  "$BB" plugin build . >/dev/null
  if [ ! -f dist/app.js ] || [ ! -f dist/server.js ]; then
    echo "ERROR: '$BB plugin build' left no dist/app.js or dist/server.js." >&2
    exit 1
  fi
  npm pack --pack-destination "$WORK" >/dev/null
)
TARBALL="$(ls "$WORK"/*.tgz)"

echo "▶ installing the package as bb does, and checking it"
npm install --prefix "$WORK/install" "$TARBALL" --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund >/dev/null
INSTALLED="$WORK/install/node_modules/${NAME}"
for file in dist/app.js dist/app.meta.json dist/app.css dist/server.js dist/server.meta.json server.ts state.ts forms.ts; do
  if [ ! -f "$INSTALLED/$file" ]; then
    echo "ERROR: the package is missing ${file}." >&2
    exit 1
  fi
done
# bb refuses an artifact stamped with another plugin or version than the package's.
node -e '
  const [dir, version] = process.argv.slice(1);
  const id = require(`${dir}/package.json`).bb.name;
  for (const artifact of ["app", "server"]) {
    const meta = require(`${dir}/dist/${artifact}.meta.json`);
    if (meta.pluginId !== id || meta.pluginVersion !== version) {
      console.error(`ERROR: dist/${artifact}.meta.json is stamped ${meta.pluginId}@${meta.pluginVersion}, not ${id}@${version}`);
      process.exit(1);
    }
  }
' "$INSTALLED" "$VERSION"

if [ "$DRY_RUN" = 1 ]; then
  echo "✓ ${NAME}@${VERSION} is ready; dry run, so nothing was published or tagged"
  tar -tzf "$TARBALL" | sed 's/^/  /'
  exit 0
fi

echo "▶ publishing ${NAME}@${VERSION}"
npm publish "$TARBALL" --access public
git tag -a "$TAG" -m "bb plugin ${VERSION}"
echo "✓ published ${NAME}@${VERSION} and tagged ${TAG} at $(git rev-parse --short HEAD)"
echo "  push the tag with: git push origin ${TAG}"
