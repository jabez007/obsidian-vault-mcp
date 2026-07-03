---
name: obsidian-companion
description: >-
  The primary skill for interacting with an Obsidian vault. Use for basic 
  operations like reading notes, writing/appending content, managing daily 
  notes, and general vault maintenance. For searching or deep research, 
  prefer the specialized 'search' or 'research' skills.
---

# Obsidian Companion Skill

## Description

This skill enables you to act as an expert companion for the user's Obsidian Vault. You can read, write, search, and "chat" with their notes using local RAG (Retrieval Augmented Generation).

## Capabilities

- **Read Notes:** Access the raw markdown of any note.
- **Write/Append:** Create new notes or append to existing ones (perfect for logs, ideas).
- **Surgical Edits:** Replace one exact string in a note without rewriting the whole file.
- **Daily Notes:** Quickly access or create today's daily journal entry.
- **Search:** Find notes by keyword or filename (Delegates to `/search`).
- **Semantic Search (RAG):** Answer complex questions by finding relevant chunks across the entire vault (Delegates to `/research`).
- **Indexing:** Build a local vector index of the vault to enable RAG.
- **Link Audits:** Find broken wikilinks before they rot the graph.

## Workflow Guidelines

### 1. Initialization

- **Check Vault Path:** Before calling any tool, ensure you know the `vault_path`. If it's not provided in the current context or environment (`OBSIDIAN_VAULT_PATH`), ask the user: "Please provide the absolute path to your Obsidian Vault."
- **Custom Metadata Storage:** If the user wants to store indexing data in a specific project directory instead of the global home directory, you can use the `workspace_path` parameter in `obsidian_set_vault`, `obsidian_rag_index`, and `obsidian_rag_query`.
- **Shared Metadata Across Machines:** If the user syncs their vault (e.g., via Git, Dropbox, iCloud) and uses it on multiple computers with different absolute paths, they can use the `vault_id` parameter to ensure the same identifier is used for the metadata cache on each machine.
- **First Time RAG:** If the user asks a semantic question (e.g., "Summarize my thoughts on AI"), try `obsidian_rag_query`. If it returns an error or no results, suggest running `obsidian_rag_index` first.

### 2. Retrieval Strategy

- **Specific Note:** If the user asks for a specific file (e.g., "Read my Daily Note for today"), use `obsidian_read_note` or the specialized `obsidian_get_daily_note`.
- **Keyword Search:** If the user is looking for a topic but not a specific question (e.g., "Find notes about 'cooking'"), use the `/search` skill.
- **Complex Q&A:** For questions requiring synthesis (e.g., "What have I learned about React this month?"), use the `/research` skill.

### 3. Writing & Logging Strategy

- **Structured Logging:** To log an entry (e.g., meeting summary, task, or thought), follow this workflow:
    1.  **Retrieve Daily Note:** Call `obsidian_get_daily_note` to get the current note's `file_path`.
    2.  **Format Entry:** Prepare your summary preceded by a separator (e.g., `\n---\n\nYour summary here`).
    3.  **Insert:** Use `obsidian_insert_at_heading` with the `file_path` from step 1. Use a relevant heading like "Work Log", "Meetings", or "Notes".
- **Quick Capture:** For simple, untimestamped additions, use `obsidian_append_note` on the target file.
- **New Topics:** Use `obsidian_create_note` for substantial new subjects.
- **Surgical Fixes:** Use `obsidian_replace_in_note` for targeted textual updates.

### 4. Context Management

- **Links:** When reading a note, pay attention to `[[Wikilinks]]`. You can explore these by calling `obsidian_read_note` on the linked title (appending `.md` if needed).
- **Broken Links:** Use `obsidian_get_broken_links` to audit a folder before large cleanups or MOC refactors.
- **Frontmatter:** Respect YAML frontmatter (tags, aliases) for context.

## Example Interactions

**User:** "What did I work on last week?"
**Agent:** (Calculates dates, checks `obsidian_rag_query` with "work done last week" OR checks specific daily notes via `obsidian_list_notes` + `obsidian_read_note`)

**User:** "Log that I finished the API integration."
**Agent:** 
1. Calls `obsidian_get_daily_note()` -> returns `{"file_path": "JRNL/2026/04/2026-04-13.md", ...}`
2. Calls `obsidian_insert_at_heading(file_path="JRNL/2026/04/2026-04-13.md", heading="Work Log", content="\n---\n\nFinished the API integration.")`

**User:** "Index my vault."
**Agent:** `obsidian_rag_index(vault_path="/Users/me/Vault")`

**User:** "Index my vault at /Users/me/Vault but keep the index in /Users/me/Project/.obsidian-vault-mcp"
**Agent:** `obsidian_rag_index(vault_path="/Users/me/Vault", workspace_path="/Users/me/Project")`

**User:** "Find the recipe for lasagna."
**Agent:** `Use /search with the query "lasagna".`
