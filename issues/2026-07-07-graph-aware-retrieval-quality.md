## Summary
Make "graph-aware search" a real query capability, not just embedded text

## Status
**Resolved** (2026-07-07). Chunks store clean content in `text` with the metadata-wrapped embedder input kept server-side in `embedding_text`, which is also the FTS target so keyword search still matches entity/community labels and heading terms absent from note bodies; query results ship only the clean columns. `obsidian_rag_query` gained `entities`/`communities` filters (exact, case-sensitive `array_contains` predicates; malformed input is rejected loudly, and the CLI coerces `array`-typed flags generically). `heading_path` carries the full H1–H6 breadcrumb from a fence-aware parser (code-block `#` lines are content, and fenced blocks are never split); when the embedding-context budget truncates, breadcrumb detail is dropped before graph metadata. Schema version bumped to 3 with the read path now refusing a version-mismatched index the same way writes do. Accepted tradeoff: chunks never merge across heading boundaries, so heading-dense notes yield more, smaller chunks.

## Context
Today the graph metadata (entities, communities) is comma-joined and stuffed into the *embedded text* as a `[METADATA: ...]` prefix (`src/rag/chunking.ts`). That has three consequences: query results echo the wrapper back to the model; `obsidian_rag_query` offers no actual entity/community filtering; and chunks carry no document context (which heading they sit under). The "graph-aware" claim in the tool descriptions currently oversells what the query path can do.

## Proposed Changes
1. **Separate stored text from embedded text**: Keep the metadata-wrapped string for embedding, but store the clean chunk text in its own column so `obsidian_rag_query` returns clean content.
2. **Filter parameters**: Add optional `entities`/`communities` filters to `obsidian_rag_query` that translate to LanceDB where-clauses over the array-typed columns.
3. **Heading breadcrumbs**: Enrich chunk metadata with the H1/H2 path each paragraph sits under (reusing the section parsing in `src/utils.ts`), and include the breadcrumb in both the embedded text and the query output so results carry document context.
4. **Benchmark**: Before/after comparison on a sample vault with a handful of representative queries; record the results in the PR description.

## Expected Behavior
- Query results contain clean note content plus a heading breadcrumb, no `[METADATA: ...]` artifacts.
- `obsidian_rag_query` can restrict results to chunks tagged with given entities or communities.
- Retrieval relevance measurably improves (or at least does not regress) on the benchmark queries.

## Impact
**Medium** — Improves answer quality for every downstream host. Requires a reindex to populate the new columns.

## Additional Context
**Depends on** [[2026-07-07-explicit-schema-and-unified-indexing-pipeline]] — array-typed `entities`/`communities` columns and the clean-text column need the explicit schema in place first.
