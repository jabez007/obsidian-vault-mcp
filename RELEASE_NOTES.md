# Release v2.1.0

## Summary

Version 2.1.0 adds local index snapshots for sharing and fixes indexing consistency, Claude plugin startup, and unnecessary database maintenance.

## Highlights

- Prepare a validated copy of an existing index with `obsidian_prepare_index_snapshot` through CLI or MCP, without generating embeddings. Unchanged source indexes reuse the existing export, including after an unchanged vault scan.
- Recover abandoned snapshot staging directories and support successfully indexed empty notes. Snapshot preparation reports stale input and validation failures explicitly.
- Apply consistent markdown eligibility rules across scans, writes, and moves, and remove old excluded entries from the index.
- Serialize Claude plugin dependency installation and retain bounded session-hook failure logs.
- Move database optimization out of individual note writes. Run maintenance after a changed vault scan or request it explicitly with `obsidian_rag_index --maintenance true`.

## Upgrade

This release preserves the version 2 API and version 3 index schema. Existing version 2.0.0 indexes do not require a full rebuild. Run a normal vault scan to reconcile entries created under the previous indexing rules.

Snapshot preparation currently supports local, untagged indexes using LanceDB 0.27.2. It creates a local export; Git tracking and synchronization remain the caller's responsibility. Claude plugin startup requires `flock`.

---

# Release v2.0.0

## Summary

Version 2.0.0 renames the project to Obsidian Vault MCP, adds first-class support for Claude Code, Codex, OpenCode, Gemini CLI, and generic MCP hosts, and strengthens the local RAG pipeline for reliable multi-host use.

## Highlights

- Published as `@jabez007/obsidian-vault-mcp`, with host manifests pinned to major version 2.
- Consolidated all 18 MCP tools into one registry shared by MCP and one-shot CLI dispatch.
- Added graph-aware hybrid retrieval with heading breadcrumbs and exact entity/community filters.
- Added an explicit LanceDB schema, schema-version migrations, cross-process index locking, and stale-index notices.
- Added Claude Code marketplace packaging and OpenCode configuration while retaining Codex and Gemini support.
- Added vault-boundary enforcement that resolves symlinks before allowing per-call path overrides.
- Protected create and move operations from replacing notes unless `overwrite: true` is explicit.
- Added automatic synchronization for host metadata, generated plugin assets, package versions, and license declarations.

## Breaking Changes

- The project and MCP server key changed from `gemini-obsidian` to `obsidian-vault-mcp`.
- New configuration writes use `~/.obsidian-mcp.config.json`; the legacy Gemini-named file remains a read-only fallback.
- Existing local RAG indexes must be rebuilt for the version 3 schema.

## Upgrade

Reinstall host integrations that reference the old project name, then rebuild the local index:

```sh
npx -y @jabez007/obsidian-vault-mcp@2 obsidian_rag_index --force_reindex true
```

The first embedding request may download the local model from Hugging Face if it is not already cached.

## Known Dependency Advisories

Four high-severity transitive advisories remain in `adm-zip` and `sharp` through `@huggingface/transformers`. `adm-zip` has no fixed release. The `sharp` issues are fixed in 0.35.0, but Transformers 4.2.0 still constrains installations to the vulnerable 0.34.x line. The affected ZIP extraction and image-processing paths are not exposed by the text-only MCP tools; see `SECURITY.md` for details.

---

# Release v1.8.0

## Summary
This release introduces robust workspace isolation and enhanced vault configuration, enabling better project-level management of your Obsidian knowledge base. Building on the foundation of v1.7.0, we have added advanced storage isolation and a new configuration API to provide users with more control over where and how their AI metadata is stored.

## New Features
- **Workspace-Aware Isolation**:
  - Specify a `workspace_path` to store vector indices and file hashes in a dedicated project folder.
  - Automatically defaults to a **Hashed Global Cache** when no workspace is provided, ensuring unique indices for every vault.
  - Track AI metadata in Git alongside your notes for better portability.
  - Configure a custom `workspace_path` or `vault_id` for granular storage control via `obsidian_set_vault`.
  - Native integration with Obsidian's core **Daily Notes** plugin configuration.

- **New Configuration Tool**:
  - `obsidian_get_config`: Retrieve the current session configuration, returning `vault_path`, `workspace_path`, and `vault_id`.

## Reliability & Performance
- **Atomic Indexing**: Precise chunk tracking and atomic hash updates ensure consistency even during partial failures.
- **Cross-Platform Hardening**: Harden path validation to support Windows separators and Unicode filenames.
- **Stability**: Ensure stale database connections are cleared when switching vaults and implement thread-safe locking for database operations.

---

# Release v1.7.0

## Summary
This release adds 10 new skills and 2 new agents ported from obsidian-rag, fixes a LanceDB stale fragment bug that broke incremental reindexing, and updates all dependencies to their latest versions.

## New Features
- **New AI Skills & Agents**:
  - **Skills**: compound, cross-linker, index, journal, links, research, search, vault, vault-lint, wiki-ingest.
  - **Agents**: researcher (deep vault research with semantic search chaining), librarian (vault organization and maintenance).
  - **Existing Skills Updated**: knowledge (promotion to global vaults), link-audit (broken links/orphans), moc-update (MOC suggestions).

- **LanceDB Optimization**:
  - Fixed stale fragment error by calling `table.optimize()` after indexing, ensuring the database remains in a consistent state during incremental reindexing.

## Infrastructure
- Updated dependencies: @lancedb/lancedb 0.27, sharp 0.34, esbuild 0.28, TypeScript 6.0, @modelcontextprotocol/sdk 1.29.
- Added SECURITY.md, CODE_OF_CONDUCT.md, PR template.
- Added repository metadata to package.json.

---

# Release v1.6.1

## Summary
Routine maintenance release. Bumps the `picomatch` dev-dependency from 4.0.3 to 4.0.4 (security/patch update via Dependabot). No functional changes.

## Build & Maintenance
- **picomatch** upgraded from 4.0.3 → 4.0.4 (dev dependency)

---

# Release v1.6.0

## Summary
This release introduces advanced vault management capabilities, including broken link detection, surgical inline text replacement, and automated workspace hooks. We have also added three new specialized skills to enhance long-term knowledge management and vault health.

## New Features
- **Vault Health & Repair**:
  - `obsidian_get_broken_links`: Automatically identifies all wikilinks in the vault that point to non-existent notes.
  - `obsidian_replace_in_note`: Enables targeted, surgical text replacement for repairing broken links without rewriting entire files.
  - Upgraded `obsidian_update_frontmatter` to support single-key and batch updates.

- **Automated Lifecycle Hooks**:
  - **Session Initialization**: Automatically reports vault status and refreshes the RAG index when a Gemini session starts.
  - **Frontmatter Validation**: Prevents the creation of notes with missing required metadata fields via configurable schema rules.
  - **Note Re-indexing**: Specialized re-indexing script for more efficient single-note updates.

- **New AI Skills**:
  - `knowledge`: Tools for promoting cross-project findings to the global engineering vault.
  - `link-audit`: Comprehensive audit of broken links, orphaned notes, and semantic clusters.
  - `moc-update`: Automated suggestions for updating Maps of Content (MOCs) after note creation.

## Developer Experience
- **Expanded Test Coverage**: New tests for batch frontmatter updates, surgical replacement logic, and recursive note listing.
- **Improved Utilities**: Refactored internal file handling to support robust recursive path patterns.

---

# Release v1.5.0

## Summary
This release introduces workspace-aware metadata storage, providing better isolation for multiple vaults and allowing users to store indexing data within project directories. We have also hardened path validation and improved the reliability of incremental indexing.

## New Features
- **Workspace-Aware Isolation**:
  - Implement workspace-aware metadata storage for RAG index and hashes.
  - Add support for multiple isolated vaults using a hashed global cache.
  - Persist vault and workspace paths, with environment variable overrides at load time.
  - Follow symlinks to support indexing external files.

## Fixed
- **Incremental Indexing**: Atomic hash updates prevent stale indices on partial failures.
- **Cross-Platform Support**: Harden path validation for Windows separators and Unicode filenames.
- **Stability**: Ensure stale database connections are cleared when switching vaults.

## Refactor
- **Thread Safety**: Implement thread-safe locking for database operations.
- **Architecture**: Decouple storage path resolution from singleton state.

---

# Release v1.4.0

## Summary
This release is a major step forward for `obsidian-vault-mcp`, focusing on security, architecture, and developer productivity. We have implemented critical security hardening to prevent path traversal vulnerabilities, refactored the RAG (Retrieval-Augmented Generation) engine for better maintainability, and introduced powerful new tools for surgical manipulation of Markdown sections. Additionally, a full testing suite and CI/CD pipeline have been established to ensure ongoing stability.

## New Features
- **Surgical Section Tools**:
  - `obsidian_replace_section`: Replace the body of a heading without touching the rest of the file.
  - `obsidian_insert_at_heading`: Insert content at the beginning or end of a specific section.
  - Enhanced `obsidian_append_daily_log`: Now uses the new section range logic for more robust appending under headings.

- **RAG Refactor**:
  - Extracted the chunking and embedding logic into a dedicated standalone module (`src/rag/chunking.ts`).
  - Improved text splitting and segment merging algorithms for more efficient embedding.

## Security Hardening
- **Path Traversal Protection**: Implemented strict path validation (`getSafeFilePath`) across all tool handlers. This prevents accidental or malicious access to files outside of the defined Obsidian vault boundary.

## Developer Experience & Quality
- **Testing Suite**: Added a comprehensive unit testing suite using `vitest`, covering chunking, utility functions, and vault operations.
- **CI/CD**: Integrated GitHub Actions for automated verification of every commit.

## Operational Notes
- The vault path is now strictly enforced. Ensure your `OBSIDIAN_VAULT_PATH` or the path passed via `obsidian_set_vault` is a valid absolute path.

# Release v1.3.0

## Summary
This release focuses on improving the robustness and efficiency of the RAG (Retrieval-Augmented Generation) system. It introduces a significant overhaul to the vault processing engine, enabling true incremental indexing. This means only modified files are processed, drastically reducing the time and resources needed to keep your vault index up to date. Additionally, strict runtime checks and dependency pinning have been added to ensure stability across different environments.

## New Features
- **Incremental Indexing & Vault Overhaul**:
  - The indexing engine now tracks file hashes to identify changed content.
  - Only modified or new files are re-embedded and updated in the vector database.
  - This overhaul improves performance for large vaults and reduces API usage for embedding models.

## Bug Fixes
- **Runtime Compatibility**:
  - Pinned `onnxruntime-node` to version `1.14.0` to ensure compatibility with `@xenova/transformers`.
  - Added a startup check that verifies the installed `onnxruntime-node` version matches requirements, preventing obscure runtime crashes.

## Operational Notes
- If you encounter errors related to `onnxruntime-node` after upgrading, please ensure you run `npm install` in the extension directory to apply the pinned version.

# Release v1.2.0

## Summary
This release introduces significant improvements to the indexing engine for better reliability and performance with large vaults. It also refines the CLI and hook integration for a smoother experience.

## New Features
- **Large Vault Indexing**: Overhauled the indexing process to handle large volumes of notes more reliably, with better error recovery and progress reporting.

## Bug Fixes
- **CLI Flags**: Correctly handle boolean flags in CLI.
- **Hook Integration**: Prevent full re-indexing during hook execution to improve performance and avoid redundant work.
- **Input Handling**: Use stdin for hook input to avoid issues with shell substitution and large payloads.

## Operational Notes
- The `dist/` directory is no longer ignored by git, ensuring that built assets are available for distribution.
- `package-lock.json` has been updated to reflect current dependency states.
