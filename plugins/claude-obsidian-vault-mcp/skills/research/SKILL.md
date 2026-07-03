---
name: research
description: >-
  Answer questions or synthesize information based on the user's personal 
  knowledge, notes, and past thoughts. Use when the user asks "what do I 
  know about...", "summarize my ideas on...", or needs to retrieve 
  conceptual information from their own documentation. Employs RAG to 
  search across all personal records.
---

# Deep Vault Research

Research a topic across the user's Obsidian vault using a multi-pass, graph-aware approach.

## Workflow

1. **Semantic Discovery** — Call `obsidian_rag_query` with the user's question. This surfaces the most relevant chunks, leveraging prepended graph metadata (`entities`, `communities`) for better contextual matching.

2. **Targeted Reading** — For each high-relevance result, call `obsidian_read_note` to get the full context. Skim for the most pertinent sections.

3. **Link Traversal** — When a relevant note is identified, normalize it to one relative `.md` file path first. Call `obsidian_get_links` with that value as `file_path` to find connected knowledge, then read promising linked notes.

4. **Synthesis** — Combine findings into a clear answer with citations:
   - Reference specific notes by name: `[[Note Name]]`
   - Quote relevant passages when helpful
   - Note any gaps or contradictions in the vault's knowledge

## Arguments

The user's query follows the skill invocation. Example: `/research what do I know about authentication patterns`

## Tips

- If RAG returns no results, suggest running `/index` first
- For broad topics, do multiple RAG queries with different phrasings
- Always cite which notes your answer draws from
