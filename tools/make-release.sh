#!/usr/bin/env bash
# Packs app/ as a ready-to-install folder named after the app, so nobody has to rename
# "monster-ui-call-route-visualizer-main/app" by hand (Monster loads apps/<name>/app.js).
#
#   tools/make-release.sh [git-ref]      default ref: HEAD (committed files only)
#
# Writes dist/call-route-visualizer.zip and dist/call-route-visualizer.tar.gz, each holding a
# single call-route-visualizer/ folder (app.js, metadata/, ...). Attach both to a GitHub release:
#   gh release create v<version> dist/call-route-visualizer.zip dist/call-route-visualizer.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=call-route-visualizer
REF=${1:-HEAD}
VERSION=$(git show "$REF:app/VERSION" | tr -d '[:space:]')
META_VERSION=$(git show "$REF:app/metadata/app.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
META_NAME=$(git show "$REF:app/metadata/app.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).name))')

[ "$META_NAME" = "$NAME" ] || { echo "app.json name is '$META_NAME', expected '$NAME'" >&2; exit 1; }
[ "$META_VERSION" = "$VERSION" ] || { echo "app/VERSION ($VERSION) != app.json version ($META_VERSION)" >&2; exit 1; }

mkdir -p dist
rm -f "dist/$NAME.zip" "dist/$NAME.tar.gz"
git archive --format=zip    --prefix="$NAME/" -o "dist/$NAME.zip"    "$REF:app"
git archive --format=tar.gz --prefix="$NAME/" -o "dist/$NAME.tar.gz" "$REF:app"

echo "$NAME $VERSION from $(git rev-parse --short "$REF")"
ls -l "dist/$NAME.zip" "dist/$NAME.tar.gz"
