## Summary
Add cross-process locking for the shared index and a staleness signal on query

## Status
**Resolved** (2026-07-07). An advisory `index.lock` (atomic `wx` create, token-guarded release, PID+hostname+age staleness with a bounded env-tunable wait) protects `indexVault`/`indexFile`/`moveFile`; stale-lock takeover only proceeds while the lock is byte-identical to the one judged stale, so competing waiters cannot delete each other's fresh locks, and content-less locks clear after a 5s grace instead of blocking for the full stale window. `obsidian_rag_query` compares a raw-glob count/mtime snapshot against `index-metadata.json` and appends a stale notice; single-file reindexes merge into the metadata (only the indexed file advances the mtime watermark) so external edits stay detected. Known residuals, documented in code and README: timestamp-preserving restores (git checkout, sync rollbacks) are invisible to the heuristic, and external deletions racing a write-tool reindex are reconciled at the next full index.

## Context
Two related gaps:
1. **Concurrency**: The `SessionStart` hook (`scripts/session-init.sh`) and the MCP server can index the same vault concurrently. The in-process mutex in `VaultIndexer` does not protect the shared LanceDB directory or `file-hashes.json` across processes, so hash writes are last-writer-wins. The rename-race workaround in `getStorageRoot` (`src/rag/store.ts`) shows this has already bitten once.
2. **Staleness**: Edits made directly in the Obsidian app mid-session leave the index silently stale — RAG queries return outdated chunks with no indication anything is wrong.

## Proposed Changes
1. **Advisory lock file** in the per-vault storage dir (`.obsidian-vault-mcp/vaults/<id>/`), acquired around `indexVault`, `indexFile`, and `moveFile`. Include stale-lock handling (PID liveness check) and a bounded wait with a clear error on timeout.
2. **Cheap staleness check** on `obsidian_rag_query`: compare vault file mtimes/counts against an indexed-at watermark recorded at index time. On mismatch, either trigger an incremental index or append an "index may be stale, run obsidian_rag_index" notice to the query results.
3. **Latency budget**: The staleness check must be O(file stat), never O(re-hash). If a full stat sweep is too slow for large vaults, sample or check directory mtimes.

## Expected Behavior
- Concurrent indexing from the hook and the server serializes cleanly instead of interleaving writes.
- A crashed process does not leave the vault permanently locked.
- Queries against a stale index either self-heal or clearly say so.

## Impact
**Medium** — Removes a silent-corruption window (concurrent hash writes) and a silent-wrongness window (stale results). Adds a small, bounded cost to query latency.

## Additional Context
The existing `getStorageRoot` migration race comment documents the concurrent-process reality. Design constraint: safe failure and clean recovery — a lock that can strand the user is worse than no lock.
