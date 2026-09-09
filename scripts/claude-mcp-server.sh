#!/usr/bin/env bash
set -euo pipefail

SCRIPT_SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SCRIPT_SOURCE" ]; do
  SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" && pwd)"
  SCRIPT_SOURCE="$(readlink "$SCRIPT_SOURCE")"
  if [[ "$SCRIPT_SOURCE" != /* ]]; then
    SCRIPT_SOURCE="$SCRIPT_DIR/$SCRIPT_SOURCE"
  fi
done

SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-$PLUGIN_ROOT/.claude-plugin-data}"
STAMP_FILE="$PLUGIN_DATA/.install-stamp"

mkdir -p "$PLUGIN_DATA/dist"

if ! command -v flock >/dev/null 2>&1; then
  echo 'Obsidian launcher requires flock (provided by util-linux on Linux).' >&2
  exit 1
fi
lock_wait="${OBSIDIAN_INSTALL_LOCK_WAIT_SECONDS:-120}"
if [[ ! "$lock_wait" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo 'OBSIDIAN_INSTALL_LOCK_WAIT_SECONDS must be a non-negative number.' >&2
  exit 1
fi
# Keep the lock inode in place. Removing it can split waiters across two locks.
exec 9>"$PLUGIN_DATA/.install.lock"
if ! flock -w "$lock_wait" 9; then
  echo "Timed out waiting for Obsidian dependency install lock after ${lock_wait}s: $PLUGIN_DATA/.install.lock" >&2
  exit 1
fi

current_stamp=$(
  cd "$PLUGIN_ROOT"
  sha256sum package.json package-lock.json dist/index.js
)

if [ ! -f "$STAMP_FILE" ] || [ "$(cat "$STAMP_FILE")" != "$current_stamp" ] || [ ! -d "$PLUGIN_DATA/node_modules/@lancedb/lancedb" ]; then
  rm -f "$STAMP_FILE"
  cp "$PLUGIN_ROOT/package.json" "$PLUGIN_DATA/package.json"
  cp "$PLUGIN_ROOT/package-lock.json" "$PLUGIN_DATA/package-lock.json"
  cp "$PLUGIN_ROOT/dist/index.js" "$PLUGIN_DATA/dist/index.js"
  # Keep stdout clean: in MCP stdio mode it is the JSON-RPC channel, and any
  # npm output there corrupts the handshake on first launch.
  (cd "$PLUGIN_DATA" && npm ci --omit=dev --no-fund --no-audit --loglevel=error >&2)
  printf '%s' "$current_stamp" > "$STAMP_FILE.tmp"
  mv "$STAMP_FILE.tmp" "$STAMP_FILE"
fi

# The server may live for the whole session. Its install lock must not.
flock -u 9
exec 9>&-
exec node "$PLUGIN_DATA/dist/index.js" "$@"
