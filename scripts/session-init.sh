#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}}"
SERVER_COMMAND="${OBSIDIAN_MCP_SERVER_COMMAND:-npx -y @jabez007/obsidian-vault-mcp@2}"
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

  if index_output=$(eval "$SERVER_COMMAND obsidian_rag_index" 2>/dev/null); then
    if printf '%s' "$index_output" | grep -q '"chunks":0'; then
      index_line="RAG index up to date"
    elif printf '%s' "$index_output" | grep -q '"chunks"'; then
      chunks=$(printf '%s' "$index_output" | grep -o '"chunks":[0-9]*' | head -n 1 | grep -o '[0-9]*')
      index_line="RAG index updated: $chunks chunks indexed"
    else
      index_line="RAG index check completed"
    fi
  else
    index_line="RAG index refresh failed"
  fi

  message="$status_line"$'\n'"$index_line"
else
  message="Obsidian vault not configured. Use obsidian_set_vault to set your vault path."
fi

escaped_message=$(printf '%s' "$message" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => process.stdout.write(JSON.stringify(data)));" )
printf '{"systemMessage":%s,"suppressOutput":true,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}
' "$escaped_message" "$escaped_message"
