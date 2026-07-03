# Obsidian Vault MCP

This project integrates your **Obsidian Vault** into Codex and other MCP-capable hosts, while retaining compatibility with the legacy Gemini CLI extension manifest. It exposes a local MCP server so you can read, search, connect, and maintain notes from your workflow.

## Features

- **🧠 Hybrid Search (RAG + FTS)**: Ask natural language questions about your notes. The server indexes your vault using embeddings (via LanceDB) and native Full-Text Search (FTS / BM25) to find highly relevant context by combining semantic meaning with precise keyword matching.
- **🕸️ Graph Traversal**: Navigate your knowledge graph. Find backlinks (`[[linked from]]`) and outgoing links to surf your ideas.
- **🛠️ Link Repair**: Audit broken wikilinks and make surgical in-note replacements without rewriting whole files.
- **📝 Smart Journaling**: Fetch today's daily note or append logs to specific headings (e.g., `## Work Log`) with timestamps.
- **⚡ Management**: Create, move, rename notes, safely update YAML frontmatter in single or batch mode, and edit specific sections.
- **🔍 Fuzzy Search**: Quickly find files by name or content.

## Demo

![demo.gif](docs/demo.gif)

## Prerequisites

- **Node.js**: v20 or higher.
- **Codex CLI** or another MCP-capable host.
- **Obsidian Vault**: A local folder containing your markdown notes.

## Installation

### MCP host configuration

Published installs launch through npm, so hosts do not need a cloned checkout:

```json
{
  "mcpServers": {
    "obsidian-vault-mcp": {
      "command": "npx",
      "args": ["-y", "@jabez007/obsidian-vault-mcp@2"]
    }
  }
}
```

### Codex plugin

This repo includes a repo-scoped Codex marketplace at `.agents/plugins/marketplace.json` and a dedicated plugin wrapper at `plugins/obsidian-vault-mcp/`. The Codex plugin launches the published MCP server with `npx -y @jabez007/obsidian-vault-mcp@2`, so copied plugin directories do not depend on repository-relative build paths.

Then open Codex in this repository, restart if it was already running, and install the plugin from the repo marketplace:

```text
/plugins
```

Look for the `Obsidian Vault MCP Repo` marketplace and install `Obsidian Vault`.

If you want to use this repository as a marketplace source from outside the repo checkout, add it explicitly:

```sh
codex plugin marketplace add /absolute/path/to/obsidian-vault-mcp
```

### Legacy Gemini CLI extension

Gemini compatibility remains in place through `gemini-extension.json`:

```sh
gemini extensions install https://github.com/jabez007/obsidian-vault-mcp
```

The extension manifest launches the published package through `npx`, so no in-extension install step is required.

### Local development

For local development, build the server in this checkout and run it directly:

```sh
npm install
npm run build
node dist/index.js
```

The packaged manifests use `npx`. Hook scripts can be pointed at a local build with:

```sh
export OBSIDIAN_MCP_SERVER_COMMAND="node /absolute/path/to/obsidian-vault-mcp/dist/index.js"
```

## Configuration

The server needs to know where your Obsidian vault is located.

### Option 1: Environment variables

Set these in your shell profile:

```bash
export OBSIDIAN_VAULT_PATH="/Users/you/Documents/MyVault"
# Optional: neutral, Codex, and legacy Gemini names are all accepted
export OBSIDIAN_WORKSPACE_PATH="/Users/you/Documents/MyProject"
export OBSIDIAN_VAULT_ID="my-personal-knowledge-base"
```

Also supported for backward compatibility: `CODEX_OBSIDIAN_*` and `GEMINI_OBSIDIAN_*`.

### Option 2: Runtime configuration

The first time you use a tool, the server can persist `vault_path`, `workspace_path`, and `vault_id`. The config source of truth is now `~/.obsidian-mcp.config.json`. The server still reads the legacy `~/.gemini-obsidian.config.json` as a fallback, but new writes no longer update that legacy file.

## Data Storage & Troubleshooting

- **Vector Index & Hashes**:
  - The server calculates a **Vault Identifier** to isolate metadata for different vaults.
  - By default, this is an **MD5 hash of the absolute vault path**.
  - If a **`vault_id`** is provided (via env var or config), it is used directly instead of the path hash. This is recommended if you sync your vault across machines where absolute paths might differ.
  - Storage location:
    - If a **workspace path** is configured, metadata is stored in `<workspace_path>/.obsidian-vault-mcp/vaults/<vault_identifier>/`.
    - Otherwise, it defaults to a **Hashed Global Cache** in `~/.obsidian-vault-mcp/vaults/<vault_identifier>/`.
  - On first access, if `.gemini-obsidian` exists and `.obsidian-vault-mcp` does not, the server automatically migrates the old storage directory to the neutral name so existing indexes are preserved.
- **Cache Reset**: If you suspect the index is corrupted or want a fresh start, you can manually delete the vault-specific folder (`.obsidian-vault-mcp/vaults/<vault_identifier>`) in your workspace or the corresponding entry in the global cache. The next time you run `obsidian_rag_index`, it will be recreated.
- **Rebuild After Upgrading to 2.0.0**: version 2.0.0 replaced the embedding library (`@xenova/transformers` → `@huggingface/transformers`). Existing indexes still load — the model and its 384 dimensions are unchanged — but vectors embedded by the new stack are not numerically identical to old ones, so an index mixing pre- and post-upgrade chunks quietly degrades ranking quality. Run a one-time full rebuild after upgrading: `npx -y @jabez007/obsidian-vault-mcp@2 obsidian_rag_index --force_reindex`.
- **Module Not Found Error**: If you see an error like `Cannot find module '@lancedb/lancedb'`, launch through `npx -y @jabez007/obsidian-vault-mcp@2` so npm installs runtime dependencies automatically. For local development, run `npm install && npm run build`.
- **Logs**: Since this runs as an MCP server, errors are typically output to stderr.

## Indexing Performance Tuning

> [!WARNING]
> Initial semantic indexing can be time- and resource-intensive, especially on large vaults.
> For first-time indexing on larger vaults, prefer running indexing directly:
> `npx -y @jabez007/obsidian-vault-mcp@2 obsidian_rag_index`

For large vaults, you can tune indexing throughput and chunk size with environment variables. Neutral names are preferred, but the Gemini-prefixed names still work:

- `OBSIDIAN_EMBED_BATCH_SIZE`, `CODEX_OBSIDIAN_EMBED_BATCH_SIZE`, or `GEMINI_OBSIDIAN_EMBED_BATCH_SIZE` (default: `48`)
- `OBSIDIAN_MIN_CHUNK_CHARS`, `CODEX_OBSIDIAN_MIN_CHUNK_CHARS`, or `GEMINI_OBSIDIAN_MIN_CHUNK_CHARS` (default: `40`)
- `OBSIDIAN_MAX_CHUNK_CHARS`, `CODEX_OBSIDIAN_MAX_CHUNK_CHARS`, or `GEMINI_OBSIDIAN_MAX_CHUNK_CHARS` (default: `1800`)
- `OBSIDIAN_TARGET_CHUNK_CHARS`, `CODEX_OBSIDIAN_TARGET_CHUNK_CHARS`, or `GEMINI_OBSIDIAN_TARGET_CHUNK_CHARS` (default: `700`)

Example preset for very large vaults:

```bash
OBSIDIAN_EMBED_BATCH_SIZE=48 \
OBSIDIAN_TARGET_CHUNK_CHARS=900 \
OBSIDIAN_MIN_CHUNK_CHARS=60 \
npx -y @jabez007/obsidian-vault-mcp@2 obsidian_rag_index
```

## Host-specific assets

- **Codex** uses `.agents/plugins/marketplace.json` and the plugin wrapper under `plugins/obsidian-vault-mcp/`.
- **Legacy Gemini CLI** continues to use `gemini-extension.json`, `commands/`, and `hooks/hooks.json`.
- **Shared behavior**: both hosts launch the published MCP package through `npx`, and note-writing MCP tools re-index the changed note inside the server.
- **Compatibility note**: the Codex wrapper intentionally does not bundle hooks yet. Gemini keeps `hooks/hooks.json`, while Codex relies on the in-server post-write reindex flow and avoids cross-host hook drift.

## Versioning

`package.json` is the version source of truth. `gemini-extension.json`, both `.codex-plugin/plugin.json` files, and the MCP server constructor derive from or are tested against the package version so release metadata stays aligned.

## Available Tools

The following tools are exposed through the MCP server for either host:

### Retrieval & Search
- `obsidian_rag_index`: Index the vault for semantic search.
- `obsidian_rag_query`: Perform a semantic search query.
- `obsidian_search_notes`: Simple text/filename search.
- `obsidian_list_notes`: List files in a folder.
- `obsidian_read_note`: Read the full content of a note.

### Graph & Connections
- `obsidian_get_backlinks`: Find all notes that link TO a specific note.
- `obsidian_get_links`: Find all notes linked FROM a specific note.
- `obsidian_get_broken_links`: Find wikilinks that point to missing notes.

### Management & Journaling
- `obsidian_create_note`: Create a new markdown note.
- `obsidian_append_note`: Append text to the end of a note.
- `obsidian_move_note`: Rename or move a note.
- `obsidian_update_frontmatter`: Safely update YAML frontmatter keys in single-key or batch mode.
- `obsidian_replace_section`: Replace the body of a heading without touching the rest of the file.
- `obsidian_insert_at_heading`: Insert content at the beginning or end of a heading section.
- `obsidian_replace_in_note`: Replace the first exact text match in a note for surgical inline edits.
- `obsidian_get_daily_note`: Get or create today's daily note.

## Skills

- `obsidian-companion`: Tool selection and vault workflow guidance.
- `research`: Multi-pass synthesis using RAG and graph traversal.
- `index`: RAG index management.
- `search`: Keyword and filename search.
- `links`: Note connection graph exploration.
- `vault`: Vault and workspace configuration.

## Development

```bash
# Build changes
npm run build
# Lint
npm run lint
# Type check
npm run type-check
# Run tests
npm test
```

## License

MIT
