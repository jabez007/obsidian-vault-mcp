#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
SERVER_COMMAND="${OBSIDIAN_MCP_SERVER_COMMAND:-npx -y @jabez007/obsidian-vault-mcp@2}"

if ! eval "$SERVER_COMMAND obsidian_rag_index --hook" </dev/stdin >/dev/null; then
  printf '{}\n'
  exit 0
fi

printf '{}\n'
