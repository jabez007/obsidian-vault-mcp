## Summary
Full reindex duplicates every chunk when the `notes` table already exists

## Status
**Resolved** in commit `7b29e9a` (2026-07-07). A full reindex over an existing table now drops it before the first write and rebuilds the FTS index; regression tests cover repeated force reindexes, the missing-hash-file variant, and incremental row stability. The fix also removed the deadlocking recursive `indexVault` call by checking schema compatibility before Phase 1, and collapsed the dead open/check/add branch in the first-write path. Remaining deferred-drop edge cases (emptied vault, total embedding failure) are tracked in [[2026-07-07-explicit-schema-and-unified-indexing-pipeline]].

## Context
In `VaultIndexer.indexVault` (`src/rag/store.ts`), `force=true` (or a missing hash file) makes `canIncremental` false, which skips the delete-old-rows block entirely. `persistChunks` then opens the *existing* table, sees the schema is valid (`hasEntities`), and calls `table.add(chunkRows)` — nothing ever drops the old rows or the table. Every forced reindex over an existing index doubles the row count. The same happens on a full index when `file-hashes.json` is missing but the table exists. No test currently exercises this path.

## Proposed Changes
1. **Regression test first**: Extend `test/indexer.test.ts` — index a small vault twice with `force=true` and assert the row count is stable across runs.
2. **Fix**: On a full (non-incremental) reindex where the `notes` table already exists, drop or truncate the table before the first write, then re-create the FTS index afterward.
3. **Verify**: Confirm incremental indexing behavior is unchanged (changed/deleted/unchanged file handling, hash bookkeeping).

## Expected Behavior
- `force_reindex=true` produces an index with exactly one set of chunks per file, regardless of prior state.
- A full index triggered by a missing hash file does not duplicate rows in an existing table.
- Incremental indexing is unaffected.

## Impact
**High** — Data corruption class bug. Duplicate rows silently degrade search relevance (duplicate hits crowd out distinct results) and grow the index unboundedly with each forced reindex.

## Additional Context
The incremental path handles deletion correctly via `deleteRowsForPaths`; only the full-reindex path is affected. Discovered during a 2026-07-07 code review of `src/rag/store.ts:322` and `src/rag/store.ts:529`.
