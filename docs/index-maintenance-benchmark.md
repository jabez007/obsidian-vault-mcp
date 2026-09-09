The maintenance fix reduced retained database growth and write latency in a seeded 200-note vault. The workload applied 60 edits and 6 moves, then ran one maintenance operation. Each note produced one chunk. These measurements were collected on Linux with Node 22.20.0 and LanceDB 0.27.2 on 2026-09-09.

The baseline uses `src/rag/store.ts` from `c512d8b`. The fixed run uses this branch. Both runs use the same note generator, chunking, and LanceDB dependency. The real-model runs use `Xenova/all-MiniLM-L6-v2` and ran consecutively outside the sandbox with the model cached. Write timings include the file write, embedding, and index update. Initial indexing and model loading are excluded from those timings.

| Measurement with real embeddings | Baseline | Fixed |
| --- | ---: | ---: |
| Retained bytes before edits | 776,887 | 776,888 |
| Retained bytes after edits and moves | 62,511,354 | 1,752,555 |
| Retained bytes after final maintenance | 63,759,647 | 2,536,210 |
| Data files after edits and moves | 126 | 67 |
| Data files after final maintenance | 127 | 69 |
| Table versions before edits | 4 | 4 |
| Table versions after edits and moves | 320 | 136 |
| Table versions after final maintenance | 323 | 139 |
| Optimizations during edits and moves | 66 | 0 |
| Optimizations including final maintenance | 67 | 1 |
| Median write latency | 113.204 ms | 27.454 ms |
| p95 write latency | 251.395 ms | 37.934 ms |
| Median move latency | 51.288 ms | 26.877 ms |
| p95 move latency | 154.894 ms | 33.913 ms |
| Median query latency before edits | 8.730 ms | 8.312 ms |
| Median query latency after edits | 7.508 ms | 11.352 ms |
| Median query latency after maintenance | 7.252 ms | 6.991 ms |

Deferring maintenance trades some query speed for lower write cost and less retained data. The final maintenance call reduces that query cost. Retained bytes increase during maintenance because both runs preserve recent table versions. The fix does not change that retention policy.

A separate run uses deterministic SHA-256 vectors to isolate database costs. Median write latency was 145.422 ms before the fix and 12.330 ms afterward. Retained bytes after the batch were 62,516,277 and 1,752,487 respectively. These runs do not measure embedding latency.

Raw measurements are available for the [real-model baseline](benchmarks/maintenance-baseline-real.json), [real-model fix](benchmarks/maintenance-fixed-real.json), [deterministic baseline](benchmarks/maintenance-baseline.json), and [deterministic fix](benchmarks/maintenance-fixed.json). They include all three storage snapshots, query p95 timings, and initial indexing durations.

To reproduce from the repository root:

```bash
git show c512d8b:src/rag/store.ts > /tmp/obsidian-baseline-store.ts
node scripts/benchmark-index-maintenance.mjs --source /tmp/obsidian-baseline-store.ts --label baseline > /tmp/baseline.json
node scripts/benchmark-index-maintenance.mjs --label fixed > /tmp/fixed.json
node scripts/benchmark-index-maintenance.mjs --source /tmp/obsidian-baseline-store.ts --label baseline-real --real-embeddings > /tmp/baseline-real.json
node scripts/benchmark-index-maintenance.mjs --label fixed-real --real-embeddings > /tmp/fixed-real.json
```

The script creates and removes its own temporary vault. `--notes` and `--edits` change the workload size. Real embeddings require a cached model or network access to download it. Keep unrelated tests and benchmarks idle during latency comparisons.

Each configuration was measured once. The seeded gardening notes exercise the write/move sequence without accessing a personal vault. They do not represent every vault's size, text distribution, or retrieval quality. Query timings use ten samples per checkpoint. Retained bytes count local database files, not unique Git LFS objects or network transfers. The baseline's final operation is a direct `table.optimize()` because its tool has no maintenance flag; the fixed run calls `indexVault` with maintenance enabled, including its unchanged-file scan.
