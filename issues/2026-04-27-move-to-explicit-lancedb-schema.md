## Summary
Transition from implicit schema inference to explicit LanceDB schema definition

## Context
The project currently relies on LanceDB's implicit schema inference during table creation (`db.createTable('notes', chunkRows)`). While convenient, this is fragile when dealing with heterogeneous metadata (e.g., some notes having graph metadata like `entities` or `communities` while others do not). Recent fixes introduced default empty strings to stabilize inference, but a formal schema is required for long-term robustness and to support advanced data types like arrays.

## Proposed Changes
1. **Define Explicit Schema**: Use Apache Arrow (via `lancedb`) to define a formal schema for the `notes` table.
   - `id`: String (Primary Key/UUID)
   - `path`: String (Relative file path)
   - `text`: String (Chunk content)
   - `vector`: Fixed-size List/Float32 (Embedding vector)
   - `entities`: List of Strings (for proper tag filtering)
   - `communities`: List of Strings
2. **Update Indexing Logic**:
   - Refactor `VaultIndexer` to use the explicit schema during `createTable`.
   - Update `buildEmbeddingInputs` to return arrays for `entities` and `communities` instead of joined strings.
3. **Migration Plan**:
   - Since LanceDB schema evolution is limited, this change will require a mandatory full reindex.
   - Add a version check or handle `Type Mismatch` errors by prompting the user to run `force_reindex`.

## Expected Behavior
- Improved stability: No more "Found field not in schema" or "Failed to infer data type" errors.
- Advanced filtering: Ability to perform exact array-contains searches on entities and communities.
- Type safety: Guaranteed column types regardless of the first batch's content.

## Impact
**Medium** - Enhances system resilience and enables more precise graph-aware RAG queries. It is a breaking change for existing local indices, requiring a rebuild.

## Additional Context
Related to recent fix for: `Found field not in schema: entities at row 7`.
Current workaround uses `''` for empty fields, but `List<String>` is the desired final state for graph-aware capabilities.
