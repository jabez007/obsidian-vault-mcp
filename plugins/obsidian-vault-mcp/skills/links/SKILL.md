---
name: links
description: >-
  Use when the user wants to explore connections between notes, see what links
  to or from a note, or says "links", "backlinks", "connections", or "graph".
---

# Explore Note Connections

Map the link graph around a specific note.

## Workflow

1. Resolve the note identifier to a single relative `.md` file path.
2. Call `obsidian_get_links` with that resolved path as `file_path` to find outgoing links.
3. Derive the backlink target from the same resolved path by removing only the `.md` extension and preserving any directories.
4. Call `obsidian_get_backlinks` with that path-without-extension as `file_name` to find incoming links.
5. Present a connection map:
   - **Outgoing links**: Notes this note references
   - **Incoming links**: Notes that reference this note

## Arguments

The note path or name follows the skill invocation. Example: `/links Projects/MyProject.md`

Normalization rules:
- If the user provides a relative `.md` path, use it directly as the resolved path.
- If the user provides only a note name or an ambiguous identifier, call `obsidian_search_notes` first and resolve it to one raw relative `.md` path before calling either link tool.
- When selecting a result from `obsidian_search_notes`, strip any display annotations such as `(Filename match)`, ensure the remaining value ends with `.md`, and use that cleaned relative path as the resolved path.

## Tips

- This skill focuses on explicit `[[wikilinks]]`.
- For a broader "meta-graph" of connections, use `/research` to leverage graph-aware semantic search (based on `entities` and `communities` in frontmatter).
- Always derive both tool arguments from the same resolved path so outgoing and incoming link results stay aligned.
- For `obsidian_get_links`, pass the full relative path with `.md` as `file_path`.
- For `obsidian_get_backlinks`, pass that same relative path without the `.md` extension as `file_name`.
