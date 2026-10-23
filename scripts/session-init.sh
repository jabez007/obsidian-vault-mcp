#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Claude Code installs the plugin's dependencies next to the bundled server.
# Other hosts, and Claude installs whose dependency step failed, use npm.
declare -a SERVER_COMMAND
if [ -n "${OBSIDIAN_MCP_SERVER_COMMAND:-}" ]; then
  read -r -a SERVER_COMMAND <<< "$OBSIDIAN_MCP_SERVER_COMMAND"
elif [ -d "$PLUGIN_ROOT/node_modules/@lancedb/lancedb" ]; then
  SERVER_COMMAND=(node "$PLUGIN_ROOT/dist/index.js")
else
  SERVER_COMMAND=(npx -y @jabez007/obsidian-vault-mcp@2)
fi

CONFIG_PRIMARY="$HOME/.obsidian-mcp.config.json"
CONFIG_LEGACY="$HOME/.gemini-obsidian.config.json"
VAULT_PATH="${OBSIDIAN_VAULT_PATH:-${CODEX_OBSIDIAN_VAULT_PATH:-${GEMINI_OBSIDIAN_VAULT_PATH:-}}}"

if [ -z "$VAULT_PATH" ]; then
  for config_file in "$CONFIG_PRIMARY" "$CONFIG_LEGACY"; do
    if [ -f "$config_file" ]; then
      VAULT_PATH=$(node -e "const fs=require('fs'); try { const v=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).vault_path || ''; process.stdout.write(v); } catch { process.stdout.write(''); }" "$config_file")
      if [ -n "$VAULT_PATH" ]; then
        break
      fi
    fi
  done
fi

message=""
if [ -n "$VAULT_PATH" ] && [ -d "$VAULT_PATH" ]; then
  note_count=$(find "$VAULT_PATH" -name '*.md' -type f 2>/dev/null | wc -l | tr -d ' ')
  status_line="Obsidian vault connected: $VAULT_PATH ($note_count notes)"

  index_line=$(node "$PLUGIN_ROOT/scripts/session-index.mjs" "${SERVER_COMMAND[@]}" obsidian_rag_index)

  message="$status_line"$'\n'"$index_line"
else
  message="Obsidian vault not configured. Use obsidian_set_vault to set your vault path."
fi

escaped_message=$(printf '%s' "$message" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => process.stdout.write(JSON.stringify(data)));" )
printf '{"systemMessage":%s,"suppressOutput":true,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}
' "$escaped_message" "$escaped_message"
