## Summary
Implement the explicit LanceDB schema and use it to collapse the triplicated indexing/recovery logic

## Context
Extends [[2026-04-27-move-to-explicit-lancedb-schema]] (issues/2026-04-27-move-to-explicit-lancedb-schema.md). The open-table → check-`hasEntities` → drop-and-recreate dance currently appears three times in `src/rag/store.ts` (`indexFile`, `indexVault`'s `persistChunks`, `moveFile`), each slightly different. The per-note pipeline (read → gray-matter → chunk → embed → delete-old-rows → add) is likewise duplicated across the three public methods. An explicit schema dissolves the recovery branches; a shared helper dissolves the pipeline duplication.

## Proposed Changes
1. **Explicit Arrow schema** for the `notes` table: `id` (String), `path` (String), `text` (String), `vector` (fixed-size List<Float32>), `entities` (List<String>), `communities` (List<String>). Create the table from the schema instead of inferring from the first batch.
2. **Schema version stamp** in the per-vault storage dir. On mismatch, take one clear "full reindex required" path instead of the three divergent `hasEntities` branches.
3. **Extract the shared per-note pipeline** into one private helper that `indexFile`, `indexVault`, and `moveFile` call.
4. **Update `buildEmbeddingInputs`** (`src/rag/chunking.ts`) to emit string arrays for `entities`/`communities` rather than comma-joined strings.
5. **Migration**: Breaking change for existing local indices — handle it with the version check, not by guessing from `Type Mismatch` errors.

## Expected Behavior
- Table schema is guaranteed regardless of the first batch's content; no more inference-related failures.
- Exactly one schema-recovery code path.
- `entities`/`communities` are queryable as real arrays (prerequisite for filter support in graph-aware retrieval).

## Impact
**Medium** — Breaking change for existing indices (one-time forced rebuild). Substantially reduces the surface area for divergence bugs in `store.ts`.

## Additional Context
Supersedes and extends issues/2026-04-27-move-to-explicit-lancedb-schema.md. Prerequisite for [[2026-07-07-graph-aware-retrieval-quality]]. Coordinate with the force-reindex duplication fix ([[2026-07-07-fix-force-reindex-chunk-duplication]]) so the "full reindex" path is correct before it becomes the migration mechanism.
