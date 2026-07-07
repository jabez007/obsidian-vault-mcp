## Summary
Add cross-process locking for the shared index and a staleness signal on query

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
