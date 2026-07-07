## Summary

Improve RAG retrieval quality so graph-aware search is a query capability, not only text injected into embeddings.

## Changes

- Store clean chunk content in `text` and keep contextual embedding input in `embedding_text`. The FTS index targets `embedding_text` so keyword search still matches entity/community labels and heading terms that never appear in note bodies; query results ship only the clean columns (no `embedding_text`, no raw vector).
- Add `heading_path` breadcrumbs from the full H1–H6 section path. The breadcrumb parser is fence-aware: `#` lines inside fenced code blocks are content, not headings, and fenced blocks are never split on blank lines. When the embedding-context budget runs out, breadcrumb detail is truncated before graph metadata.
- Add optional `entities` and `communities` filters to `obsidian_rag_query`; filters compile to LanceDB `array_contains(...)` predicates over the array-typed columns. Labels match exactly (case-sensitive); malformed filter input is rejected loudly rather than silently searching unfiltered. The CLI coerces `--entities a,b` generically via the schema's `array` type.
- Bump the local notes table schema version to force a full reindex for the new columns. Reads now enforce the stamp like writes do: querying a not-yet-migrated index fails with the `force_reindex=true` guidance instead of returning old-shaped rows or raw engine errors.
- Chunks no longer merge across heading boundaries so each chunk has one truthful breadcrumb; heading-dense notes therefore produce more, smaller chunks than before — an accepted tradeoff for breadcrumb accuracy.

## Benchmark

Sample vault shape used for the comparison:

- `ai.md`: `entities: [AI]`, `communities: [Technology]`, content about semantic search and artificial intelligence.
- `climate.md`: `entities: [Climate Change]`, `communities: [Sustainability]`, content about semantic search and climate adaptation.
- `graph-note.md`: H1 `Research`, H2 `Climate Monitoring`, graph metadata for AI/climate work.

Representative queries:

| Query | Scope | Before | After |
| --- | --- | --- | --- |
| `AI` | unfiltered graph note lookup | Returned chunk content included `[METADATA: ...]`; no heading path. | Returns clean note content, plus `heading_path: Research > Climate Monitoring`; metadata remains server-side in `embedding_text`. |
| `Sustainability` | keyword match on a label absent from every note body | Matched via the metadata wrapper embedded in stored text. | Still matches: the FTS index covers `embedding_text`, where the label lives. |
| `semantic search relevance` | `entities: [AI]` | No query-time entity filter; callers had to post-filter mixed result sets. | Returns only `ai.md` in the sample vault. |
| `semantic search relevance` | `communities: [Sustainability]` | No query-time community filter; callers had to post-filter mixed result sets. | Returns only `climate.md` in the sample vault. |

Result: user-visible output is cleaner, scoped graph queries are precise on the sample vault, and every chunk now carries document context for downstream answer synthesis.

## Test plan

- [ ] `npm run type-check` passes
- [ ] `npm run lint` passes
- [ ] `npm run build` succeeds
- [ ] `npm test` passes
- [ ] `dist/index.js` is included in the commit
