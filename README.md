# Obsidian Vault MCP

This project integrates your **Obsidian Vault** into Claude Code, Codex CLI, OpenCode, Gemini CLI, and other MCP-capable hosts. It exposes a local MCP server so you can read, search, connect, and maintain notes from your workflow.

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
- **Claude Code**, **Codex CLI**, **OpenCode**, **Gemini CLI**, or another MCP-capable host.
- **Obsidian Vault**: A local folder containing your markdown notes.

## Installation

Claude Code and OpenCode can run this server directly from a local checkout. The Codex, Gemini, and generic MCP manifests keep the package-based launch shape used by earlier releases.

### Claude Code plugin

This repo is a Claude Code plugin marketplace. From Claude Code, add the marketplace and install the plugin:

```text
/plugin marketplace add https://github.com/jabez007/obsidian-vault-mcp.git
/plugin install obsidian-vault-mcp@obsidian-vault-mcp
```

For local development or testing from a checkout:

```sh
claude plugin validate .
claude plugin marketplace add . --scope local
claude plugin install obsidian-vault-mcp@obsidian-vault-mcp --scope local
```

The Claude marketplace uses `.claude-plugin/marketplace.json` and installs the generated wrapper under `plugins/claude-obsidian-vault-mcp/`. That wrapper is generated from `.claude-plugin/plugin.json`, `.claude-plugin/mcp.json`, `.claude-plugin/hooks.json`, root `skills/`, `scripts/session-init.sh`, `scripts/session-index.mjs`, `scripts/claude-mcp-server.sh`, `package.json`, `package-lock.json`, and `dist/index.js`. The MCP server runs through `scripts/claude-mcp-server.sh`, which installs production dependencies into Claude's `${CLAUDE_PLUGIN_DATA}` directory before launching the bundled server. The `SessionStart` hook runs `scripts/session-init.sh`, which reports vault status and refreshes the RAG index when a vault is configured.

The Claude launcher requires Bash, `sha256sum`, and `flock`. On Linux, `flock` is provided by util-linux. Concurrent launches share an install lock and recheck the dependency stamp after waiting. The lock is released before the server starts. `OBSIDIAN_INSTALL_LOCK_WAIT_SECONDS` sets the maximum wait, in seconds, and defaults to `120`.

### Codex CLI plugin

This repo includes a repo-scoped Codex marketplace at `.agents/plugins/marketplace.json` and a dedicated plugin wrapper at `plugins/obsidian-vault-mcp/`. Open Codex in this repository, restart if it was already running, and install the plugin from the repo marketplace:

```text
/plugins
```

Look for the `Obsidian Vault MCP Repo` marketplace and install `Obsidian Vault`.

If you want to use this repository as a marketplace source from outside the repo checkout, add it explicitly:

```sh
codex plugin marketplace add /absolute/path/to/obsidian-vault-mcp
```

### OpenCode

Build the local checkout, then start OpenCode from this repo so it can use the included `opencode.json`:

```sh
npm install
npm run build
opencode
```

The config uses OpenCode's `mcp` format:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "obsidian-vault-mcp": {
      "type": "local",
      "command": ["node", "dist/index.js"],
      "cwd": ".",
      "enabled": true,
      "timeout": 30000
    }
  }
}
```

After OpenCode starts, ask it to use the `obsidian-vault-mcp` tools, for example: `Index my Obsidian vault using obsidian-vault-mcp`.

### Gemini CLI extension

Gemini compatibility remains in place through `gemini-extension.json`:

```sh
gemini extensions install https://github.com/jabez007/obsidian-vault-mcp
```

The extension manifest uses the package-based MCP launch shape from earlier releases, so no in-extension install step is required once that package is available to `npx`.

### Generic MCP host configuration

For other MCP-capable hosts using a local checkout, build this repo and add this server configuration:

```json
{
  "mcpServers": {
    "obsidian-vault-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/obsidian-vault-mcp/dist/index.js"]
    }
  }
}
```

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
# Optional: colon-separated absolute roots allowed for vault_path and workspace_path overrides
export OBSIDIAN_ALLOWED_VAULTS="/Users/you/Documents/MyVault:/Users/you/Documents/MyProject"
```

Also supported for backward compatibility: `CODEX_OBSIDIAN_*` and `GEMINI_OBSIDIAN_*`.

### Vault boundary

Tools accept per-call `vault_path` and `workspace_path` overrides, which is useful
for explicit multi-vault workflows but risky when note content is injected into an
agent prompt. A malicious note could otherwise ask the agent to pass an override
that reads or writes outside the intended vault.

By default, overrides are locked to the configured vault and workspace after
bootstrap. To allow more than one root, set `OBSIDIAN_ALLOWED_VAULTS` to a
colon-separated list of absolute roots. `CODEX_OBSIDIAN_ALLOWED_VAULTS` and
`GEMINI_OBSIDIAN_ALLOWED_VAULTS` are also accepted. The server resolves symlinks
before enforcing the boundary, and applies the same containment check to
`workspace_path` because it creates index and cache directories.

For note paths, the server also resolves the deepest existing target ancestor
before reads and writes. A symlink inside the vault that points outside the vault
is blocked by default, even if the path looks like it is under the vault. Vault
scans and RAG indexing still follow symlinked folders, but each followed file is
kept only when its real path remains inside the vault or inside an
`OBSIDIAN_ALLOWED_VAULTS` root. If your vault intentionally links to another
folder, add both the vault and the linked folder's real parent/root to
`OBSIDIAN_ALLOWED_VAULTS`.

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
- **Index Schema Migrations**: The index layout is stamped with a schema version (`schema-version.json`). After an upgrade that changes the layout (for example, the clean-text/heading-breadcrumb columns), both indexing and querying refuse with a message asking for a one-time `obsidian_rag_index` run with `force_reindex=true`; the rebuild restamps the version and everything resumes normally.
- **Index Coordination & Freshness**: Each vault index directory uses an advisory `index.lock` so the session hook and MCP server do not update LanceDB and `file-hashes.json` at the same time. Queries compare markdown file counts and mtimes against the last successful index metadata; if files changed directly in Obsidian, `obsidian_rag_query` may append a stale-index notice asking you to run `obsidian_rag_index`. Restores that preserve both the file count and older timestamps (e.g. `git checkout`, sync rollbacks) are not detected by this heuristic — run `obsidian_rag_index` with `force_reindex` after those.
- **Module Not Found Error**: If you see an error like `Cannot find module '@lancedb/lancedb'`, launch through `npx -y @jabez007/obsidian-vault-mcp@2` so npm installs runtime dependencies automatically. For local development, run `npm install && npm run build`.
- **Logs**: Since this runs as an MCP server, errors are typically output to stderr.

If the session hook reports `RAG index refresh failed`, open the log path included in its message. The hook keeps the five newest failure logs, each limited to the last 64 KiB of diagnostics, under `${CLAUDE_PLUGIN_DATA}/logs`. Other hosts use `${XDG_STATE_HOME}/obsidian-vault-mcp/logs`, or `~/.local/state/obsidian-vault-mcp/logs` when `XDG_STATE_HOME` is unset. Logs include stderr, the CLI response, and exit status. Successful runs do not retain a log.

Search indexes lowercase `.md` files outside hidden files and directories. This rule applies to vault scans, individual writes, and moves. Tools can still create text configuration files such as `.base` or `.yaml`; those files are excluded from search. Rewriting an excluded file removes any old rows for that path. A vault scan also reconciles old excluded entries and deleted files.

## Prepare an index for sharing

Run `obsidian_prepare_index_snapshot` after indexing your edits. From a built checkout:

```bash
node dist/index.js obsidian_prepare_index_snapshot \
	--vault_path /absolute/path/to/vault \
	--workspace_path /absolute/path/to/workspace \
	--vault_id shared-vault
```

You can omit these arguments to use the configured vault, workspace, and vault ID. The MCP tool accepts the same arguments and applies the same path boundaries. Preparation checks note contents against the recorded hashes, including changes that preserve timestamps. If the index is stale, run `obsidian_rag_index` and retry. Preparation does not index notes, generate embeddings, or download a model.

### Snapshot contract

The command returns JSON with `success`, `snapshotPath`, `sourceFingerprint`, `sourceVersion`, and `reused`. The output directory is `<vault-storage>/snapshots/<sourceFingerprint>/`. It contains `lancedb/`, `file-hashes.json`, `schema-version.json`, `index-metadata.json`, and `snapshot.json`. The manifest records payload file hashes and validation results. Locks and unfinished metadata writes are excluded.

Preparation holds the shared index lock while it copies and validates the index. It maintains the private copy and publishes the final directory only after validation succeeds. Live queries can continue because preparation does not prune the live database. A live local process's lock never expires solely because it is old. On Linux, the lock records the boot ID and process start time so a reused PID cannot retain a dead owner's lock. When this identity is unavailable, including on other platforms and in older locks, the existing process-liveness check remains in effect. A lock from another host requires explicit resolution after confirming that its owner has stopped. `OBSIDIAN_INDEX_LOCK_WAIT_MS` controls the wait, with a default of 30 seconds.

Published exports remain unchanged when the live database changes or undergoes maintenance. An unchanged source reuses the same export after checking its file hashes. A modified export causes an error instead of being overwritten. The command never automatically deletes older published exports. Remove them only after all staging or copying operations using them have finished. A killed process can leave an unpublished `.preparing-*` directory. The next valid preparation removes abandoned staging directories under the index locks, even when it reuses an existing export. This cleanup skips symlinks and unrelated entries.

### Maintenance and compatibility

Each new source state gets one `optimize()` call on its private copy, with the retention cutoff set to the preparation time and `deleteUnverified: false`. This combines compaction, index maintenance, and eligible history cleanup. Reusing an export does not call maintenance or rewrite files. Live-index maintenance retains its existing seven-day policy.

This policy reduces obsolete history but does not promise exactly one version or the smallest possible export. Versions created during maintenance and unverified files can remain. Compaction can create new LFS objects, so reduced directory size does not guarantee fewer upload bytes for every workload. Preparation cannot reclaim objects already uploaded to GitHub LFS.

The MVP supports ordinary local indexes created by this application, with the current notes schema and an existing full-text index. Tagged tables, shallow clones, externally stored data, and custom database layouts are unsupported. Tagged tables fail with the retained tag names; preparation never deletes tags. Validation checks all current rows and vectors, executes stored-vector and full-text queries, and reopens the maintained database without rebuilding its indexes. An empty indexed vault is supported.

The result records `compatibility.notesTableSchemaVersion` and `compatibility.lanceDbVersion`. Preparation requires LanceDB 0.27.2 because its manifest field map is version-specific. Other installed versions fail before manifest parsing. Use the same application and compatible LanceDB runtime on the receiving machine. A read-only manifest check rejects external references and unfamiliar formats before maintenance. All cleanup uses the supported database API.

To install an export, stop the receiving MCP processes and replace the target's `lancedb/` directory and three companion JSON files together. Do not merge the exported database with an existing one. Keep the corresponding vault notes at the same relative paths. Normal semantic queries still require the query embedding model; preparation and stored-vector validation do not.

`before` and `after` report payload bytes and file counts, excluding `snapshot.json`. `versionsBefore`, `versionsRemoved`, and `versionsRetained` report database history. `retention`, `compaction`, and `validation` describe the applied policy and checks. Failures return `success: false` with an `error.code` and actionable `error.message`. The CLI writes failures to stderr and exits nonzero; MCP returns `isError: true`.

### Template hook handoff

Capture the successful JSON response before selecting files to stage. For example, with `jq` installed:

```bash
set -e
snapshot_result_file="$(mktemp)"
trap 'rm -f "$snapshot_result_file"' EXIT
node dist/index.js obsidian_prepare_index_snapshot > "$snapshot_result_file"
snapshot_path="$(jq -er '.snapshotPath' "$snapshot_result_file")"
```

The template hook then stages or copies the contents of `snapshot_path`. It must use that exact generation through completion. Keep the local `snapshots/` cache out of Git; publishing every generation would retain unnecessary copies. If the template uses a fixed tracked export directory, the hook owns replacing its contents and coordinating staging there. Keep that tracked directory separate from the live database.

The template owns hook installation, staged-change detection, partial-staging policy, Git staging, and optional size limits. The MCP command does not invoke Git. Commit the vault notes corresponding to the snapshot, and reject or reconcile partial note staging in the hook.

## Indexing Performance Tuning

Individual writes and moves update searchable content immediately without optimizing the whole table. A vault scan that changes the index runs maintenance once at the end. An unchanged scan skips maintenance, including session-start scans.

After a batch of edits, call `obsidian_rag_index` with `maintenance: true` to compact fragments and update search indexes even when all note hashes already match. From a built local checkout:

```bash
node dist/index.js obsidian_rag_index --maintenance true
```

Explicit maintenance uses the same per-vault index lock as writes and reports `maintenancePerformed: true` on success. It cannot be combined with `file_path`. Full-text and semantic queries include rows added since the last maintenance run, but querying many unindexed fragments can take longer.

Maintenance retains seven days of table history and leaves unverified-file deletion disabled. Compaction can temporarily increase retained bytes because recent versions still reference older files. It does not remove objects from existing Git LFS history. For repeatable storage and latency measurements, see [the maintenance benchmark](docs/index-maintenance-benchmark.md).

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

- **Canonical shared assets** live at the repo root. Edit `skills/` for skills and `agents/` for local agents; do not edit generated host copies by hand.
- **Claude Code** uses `.claude-plugin/marketplace.json` and the generated wrapper under `plugins/claude-obsidian-vault-mcp/`. The wrapper contains Claude-specific `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`, `skills/`, `scripts/session-init.sh`, `scripts/session-index.mjs`, `scripts/claude-mcp-server.sh`, package manifests, and `dist/index.js`.
- **Codex package/checkouts** use `.codex-plugin/plugin.json`, `.mcp.json`, `skills/`, and `agents/` from the repo root.
- **Codex repo marketplace installs** use `.agents/plugins/marketplace.json` and the plugin wrapper under `plugins/obsidian-vault-mcp/`. The wrapper's `.codex-plugin/`, `.mcp.json`, and `skills/` are generated from the root assets.
- **OpenCode** uses `opencode.json` with its top-level `mcp` configuration and the built `dist/index.js` from this checkout.
- **Legacy Gemini CLI** continues to use `gemini-extension.json`, `commands/`, `hooks/hooks.json`, and the scripts in `scripts/`.
- **Shared behavior**: all hosts expose the same MCP server tools, and note-writing MCP tools re-index the changed note inside the server.
- **Compatibility note**: the Codex wrapper intentionally does not bundle hooks yet. Gemini keeps `hooks/hooks.json`, while Codex relies on the in-server post-write reindex flow and avoids cross-host hook drift.

After changing root skills, host plugin metadata, or `.mcp.json`, run:

```sh
npm run sync-assets
```

CI runs the same sync and fails if it changes generated host assets under `plugins/`, so host asset drift cannot merge silently.

## Versioning

`package.json` is the version source of truth. `gemini-extension.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, both `.codex-plugin/plugin.json` files, and the MCP server constructor derive from or are tested against the package version so release metadata stays aligned.

## Available Tools

The following tools are exposed through the MCP server for either host:

### Retrieval & Search
- `obsidian_rag_index`: Index the vault for semantic search.
- `obsidian_prepare_index_snapshot`: Export a stable, validated index for sharing without generating embeddings.
- `obsidian_rag_query`: Perform a semantic search query. Results carry clean note content plus a heading breadcrumb; optional `entities`/`communities` parameters (exact, case-sensitive frontmatter labels; comma-separated on the CLI) restrict results to chunks tagged with those labels.
- `obsidian_search_notes`: Simple text/filename search.
- `obsidian_list_notes`: List files in a folder.
- `obsidian_read_note`: Read the full content of a note.

### Graph & Connections
- `obsidian_get_backlinks`: Find all notes that link TO a specific note.
- `obsidian_get_links`: Find all notes linked FROM a specific note.
- `obsidian_get_broken_links`: Find wikilinks that point to missing notes.

### Management & Journaling
- `obsidian_create_note`: Create a new markdown note; refuses to replace an existing note unless `overwrite` is true.
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

ISC
