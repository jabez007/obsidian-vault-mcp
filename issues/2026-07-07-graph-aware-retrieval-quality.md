## Summary
Make "graph-aware search" a real query capability, not just embedded text

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
