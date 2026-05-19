#!/usr/bin/env bash
# Sync direction: artifacts/api-server/src/ -> source-code/src/
# source-code/ is read-only review material.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/artifacts/api-server/src"
DEST="$ROOT/source-code/src"

mkdir -p "$DEST"

# NixOS-safe sync: no rsync, use cp -a
rm -rf "$DEST"
cp -a "$SRC" "$DEST"

echo "Synced $SRC -> $DEST"
