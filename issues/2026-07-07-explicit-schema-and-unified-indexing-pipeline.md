## Summary
Implement the explicit LanceDB schema and use it to collapse the triplicated indexing/recovery logic

## Context
Extends [[2026-04-27-move-to-explicit-lancedb-schema]] (issues/2026-04-27-move-to-explicit-lancedb-schema.md). The open-table → check-`hasEntities` → drop-and-recreate dance appears in `src/rag/store.ts` in `indexFile` and `moveFile` (commit `7b29e9a` already consolidated `indexVault`'s copies into a single up-front schema check plus a drop-before-first-write reset path). The per-note pipeline (read → gray-matter → chunk → embed → delete-old-rows → add) is likewise duplicated across the three public methods. An explicit schema dissolves the remaining recovery branches; a shared helper dissolves the pipeline duplication.

## Proposed Changes
1. **Explicit Arrow schema** for the `notes` table: `id` (String), `path` (String), `text` (String), `vector` (fixed-size List<Float32>), `entities` (List<String>), `communities` (List<String>). Create the table from the schema instead of inferring from the first batch.
2. **Schema version stamp** in the per-vault storage dir. On mismatch, take one clear "full reindex required" path instead of the three divergent `hasEntities` branches.
3. **Extract the shared per-note pipeline** into one private helper that `indexFile`, `indexVault`, and `moveFile` call.
4. **Update `buildEmbeddingInputs`** (`src/rag/chunking.ts`) to emit string arrays for `entities`/`communities` rather than comma-joined strings.
5. **Migration**: Breaking change for existing local indices — handle it with the version check, not by guessing from `Type Mismatch` errors.
6. **Fix the deferred-drop edge cases on full reindex** (found in the 2026-07-07 review of the chunk-duplication fix, commit `7b29e9a`). The stale-table drop only happens on the first successful write, so two paths leave the old index behind:
   - **Emptied vault**: a full reindex with zero embeddable chunks hits the `"No content found to index"` early return before any drop — the stale table and hash file survive, and `obsidian_rag_query` keeps returning chunks for notes that no longer exist. An empty vault should truncate/drop the table and clear the hashes.
   - **Total embedding failure**: if every batch fails to embed, `persistChunks` never runs (no drop), yet the cleared hashes are written and `success: true` is returned with `chunks: 0`. This should fail loudly and leave the hash file untouched, so the next run retries instead of believing the index is fresh.

## Expected Behavior
- Table schema is guaranteed regardless of the first batch's content; no more inference-related failures.
- Exactly one schema-recovery code path.
- A full reindex never leaves stale rows behind, even when there is nothing to write: an emptied vault yields an empty index, and an embedding failure is reported as a failure without corrupting the hash bookkeeping.
- `entities`/`communities` are queryable as real arrays (prerequisite for filter support in graph-aware retrieval).

## Impact
**Medium** — Breaking change for existing indices (one-time forced rebuild). Substantially reduces the surface area for divergence bugs in `store.ts`.

## Additional Context
Supersedes and extends issues/2026-04-27-move-to-explicit-lancedb-schema.md. Prerequisite for [[2026-07-07-graph-aware-retrieval-quality]]. The force-reindex duplication fix ([[2026-07-07-fix-force-reindex-chunk-duplication]], resolved in `7b29e9a`) landed first, so the "full reindex" path is now correct and can serve as the migration mechanism.
