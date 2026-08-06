#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
declare -a SERVER_COMMAND
if [ -n "${OBSIDIAN_MCP_SERVER_COMMAND:-}" ]; then
  read -r -a SERVER_COMMAND <<< "$OBSIDIAN_MCP_SERVER_COMMAND"
else
  SERVER_COMMAND=(npx -y @jabez007/obsidian-vault-mcp@2)
fi

if ! "${SERVER_COMMAND[@]}" obsidian_rag_index --hook </dev/stdin >/dev/null; then
  printf '{}\n'
  exit 0
fi

printf '{}\n'
