import * as fs from "fs/promises";
import * as path from "path";
import { glob } from "glob";
import { getOrCreateDailyNote } from "../daily-note.js";
import {
    applyFrontmatterUpdate,
    extractWikilinks,
    findSectionRange,
    getSafeFilePath,
    insertAtHeading,
    listNotesPattern,
    replaceInNote,
    replaceSection,
    stripHeadingFromLink,
} from "../utils.js";
import type { ObsidianTool, ToolArguments, ToolContext } from "./types.js";

async function reindexNoteAfterWrite(
    context: ToolContext,
    vaultPath: string,
    relativePath: string,
    workspacePath?: string | null,
    vaultId?: string | null,
) {
    try {
        const result = (await context.indexer.indexFile(
            vaultPath,
            relativePath,
            workspacePath,
            vaultId,
        )) as { success?: boolean; message?: string };
        if (!result.success) {
            console.error(
                `Post-write reindex failed for ${relativePath}: ${result.message ?? "unknown error"}`,
            );
        }
    } catch (error) {
        console.error(`Post-write reindex failed for ${relativePath}`, error);
    }
}

async function reindexMovedNote(
    context: ToolContext,
    vaultPath: string,
    sourceRelativePath: string,
    destRelativePath: string,
    workspacePath?: string | null,
    vaultId?: string | null,
) {
    const result = (await context.indexer.moveFile(
        vaultPath,
        sourceRelativePath,
        destRelativePath,
        workspacePath,
        vaultId,
    )) as { success?: boolean; message?: string };
    if (!result.success) {
        const message = result.message ?? "unknown error";
        // The file is already renamed on disk at this point. A schema
        // migration pending on the whole index is not a reason to report the
        // move itself as failed — log it and let the forced reindex catch up.
        if (message.includes("force_reindex=true")) {
            console.error(
                `Post-move reindex skipped for ${sourceRelativePath} -> ${destRelativePath}: ${message}`,
            );
            return;
        }
        throw new Error(
            `Post-move reindex failed for ${sourceRelativePath} -> ${destRelativePath}: ${message}`,
        );
    }
}

function booleanArg(value: unknown): boolean {
    return value === true || value === "true";
}

function optionalString(value: unknown): string | undefined {
    return value === undefined || value === null ? undefined : String(value);
}

// A malformed filter must fail loudly: silently narrowing it to "no filter"
// would present unfiltered results as filtered. Array items are matched
// exactly (labels may contain commas); the string form is a comma-separated
// convenience for CLI-style callers.
function stringArrayArg(argName: string, value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) {
        if (!value.every((item): item is string => typeof item === "string")) {
            throw new Error(`'${argName}' must be an array of strings or a comma-separated string.`);
        }
        return value
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
    }
    if (typeof value === "string") {
        return value
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
    }
    throw new Error(`'${argName}' must be an array of strings or a comma-separated string.`);
}

function filterSafeVaultFiles(vaultPath: string, files: string[]): string[] {
    return files.filter((file) => {
        try {
            getSafeFilePath(vaultPath, file);
            return true;
        } catch (error: any) {
            console.error(`Skipping out-of-bounds vault file ${file}: ${error?.message ?? String(error)}`);
            return false;
        }
    });
}

export const obsidianTools: ObsidianTool[] = [
    {
        name: "obsidian_set_vault",
        description:
            "Set the default Obsidian vault path and optional structure/ID for this session.",
        inputSchema: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Absolute path to the Obsidian vault",
                },
                workspace_path: {
                    type: "string",
                    description:
                        "Optional absolute path to the workspace root where .obsidian-vault-mcp should be created.",
                },
                vault_id: {
                    type: "string",
                    description:
                        "Optional unique identifier for this vault to share metadata across machines.",
                },
            },
            required: ["path"],
        },
        async handler(args, context) {
            const vaultPath = String(args.path ?? args.vault_path ?? "");
            const workspacePath =
                "workspace_path" in args
                    ? args.workspace_path
                        ? String(args.workspace_path)
                        : null
                    : context.getConfig().workspace_path;
            const vaultId =
                "vault_id" in args || "id" in args
                    ? args.vault_id || args.id
                        ? String(args.vault_id || args.id)
                        : null
                    : context.getConfig().vault_id;
            await context.setConfig({ vaultPath, workspacePath, vaultId });
            return `Vault path set to: ${vaultPath}`;
        },
    },
    {
        name: "obsidian_get_config",
        description:
            "Get the current vault configuration (vault_path, workspace_path, vault_id).",
        inputSchema: {
            type: "object",
            properties: {},
        },
        async handler(_args, context) {
            return JSON.stringify(context.getConfig(), null, 2);
        },
    },
    {
        name: "obsidian_list_notes",
        description: "List markdown files in the vault or a subdirectory.",
        inputSchema: {
            type: "object",
            properties: {
                subfolder: {
                    type: "string",
                    description: "Optional subfolder to list",
                },
                vault_path: {
                    type: "string",
                    description: "Optional vault path override",
                },
            },
        },
        async handler(args, context) {
            const vaultPath = context.getVaultPath(args.vault_path);
            const pattern = listNotesPattern(optionalString(args.subfolder));
            const files = filterSafeVaultFiles(
                vaultPath,
                await glob(pattern, { cwd: vaultPath, follow: true }),
            );
            return (
                JSON.stringify(files.slice(0, 100), null, 2) +
                (files.length > 100 ? `\n...and ${files.length - 100} more.` : "")
            );
        },
    },
    {
        name: "obsidian_read_note",
        description: "Read the content of a specific note (Markdown).",
        inputSchema: {
            type: "object",
            properties: {
                file_path: {
                    type: "string",
                    description: "Relative path to the note",
                },
                vault_path: {
                    type: "string",
                    description: "Optional vault path override",
                },
            },
            required: ["file_path"],
        },
        async handler(args, context) {
            const vaultPath = context.getVaultPath(args.vault_path);
            const filePath = getSafeFilePath(vaultPath, String(args.file_path));
            return fs.readFile(filePath, "utf-8");
        },
    },
    {
        name: "obsidian_create_note",
        description: "Create a new note with the given content.",
        inputSchema: {
            type: "object",
            properties: {
                file_path: {
                    type: "string",
                    description:
                        'Relative path for the new note (e.g. "Ideas/MyIdea.md")',
                },
                content: {
                    type: "string",
                    description: "Initial content of the note",
                },
                vault_path: {
                    type: "string",
                    description: "Optional vault path override",
                },
                workspace_path: {
                    type: "string",
                    description: "Optional workspace path override",
                },
                vault_id: {
                    type: "string",
                    description: "Optional unique identifier for the vault",
                },
            },
            required: ["file_path", "content"],
        },
        async handler(args, context) {
            const vaultPath = context.getVaultPath(args.vault_path);
            const workspacePath = context.getWorkspacePath(args.workspace_path);
            const vaultId = context.getVaultId(args.vault_id);
            const relativePath = String(args.file_path);
            const filePath = getSafeFilePath(vaultPath, relativePath);
            const content = String(args.content || "");
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, content, "utf-8");
            await reindexNoteAfterWrite(
                context,
                vaultPath,
                relativePath,
                workspacePath,
                vaultId,
            );
            return `Created note: ${args.file_path}`;
        },
    },
    {
        name: "obsidian_append_note",
        description: "Append text to the end of an existing note.",
        inputSchema: {
            type: "object",
            properties: {
                file_path: {
                    type: "string",
                    description: "Relative path to the note",
                },
                content: { type: "string", description: "Text to append" },
                vault_path: {
                    type: "string",
                    description: "Optional vault path override",
                },
                workspace_path: {
                    type: "string",
                    description: "Optional workspace path override",
                },
                vault_id: {
                    type: "string",
                    description: "Optional unique identifier for the vault",
                },
            },
            required: ["file_path", "content"],
        },
        async handler(args, context) {
            const vaultPath = context.getVaultPath(args.vault_path);
            const workspacePath = context.getWorkspacePath(args.workspace_path);
            const vaultId = context.getVaultId(args.vault_id);
            const relativePath = String(args.file_path);
            const filePath = getSafeFilePath(vaultPath, relativePath);
            const content = String(args.content || "");
            await fs.appendFile(filePath, "\n" + content, "utf-8");
            await reindexNoteAfterWrite(
                context,
                vaultPath,
                relativePath,
                workspacePath,
                vaultId,
            );
            return `Appended to note: ${args.file_path}`;
        },
    },
    {
        name: "obsidian_get_daily_note",
        description:
            "Get (or create) today's daily note using Obsidian's plugin configuration. Returns both the relative file_path and the content.",
        inputSchema: {
            type: "object",
            properties: {
                vault_path: {
                    type: "string",
                    description: "Optional vault path override",
                },
            },
        },
        async handler(args, context) {
            const vaultPath = context.getVaultPath(args.vault_path);
            return JSON.stringify(await getOrCreateDailyNote(vaultPath));
        },
    },
    {
        name: "obsidian_search_notes",
        description: "Search for notes containing specific text (simple text match).",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Text to search for" },
                vault_path: {
                    type: "string",
                    description: "Optional vault path override",
                },
            },
            required: ["query"],
        },
        async handler(args, context) {
            const vaultPath = context.getVaultPath(args.vault_path);
            const query = String(args.query).toLowerCase();
            const files = filterSafeVaultFiles(
                vaultPath,
                await glob("**/*.md", { cwd: vaultPath, follow: true }),
            );
            const matches: string[] = [];
            for (const file of files) {
                if (matches.length >= 20) break;
                if (file.toLowerCase().includes(query)) {
                    matches.push(file + " (Filename match)");
                } else {
                    try {
                        const content = await fs.readFile(getSafeFilePath(vaultPath, file), "utf-8");
                        if (content.toLowerCase().includes(query)) matches.push(file);
                    } catch {
                        /* ignore unreadable files */
                    }
                }
                if (matches.length >= 20) break;
            }
            return matches.join("\n");
        },
    },
    {
        name: "obsidian_rag_index",
        description:
            "Index the vault for graph-aware semantic search (RAG). Automatically extracts and preserves YAML graph metadata (entities, communities) from frontmatter to enhance search context. If file_path is provided, only that file is re-indexed. Incremental by default — only re-embeds changed files. Use force_reindex to rebuild from scratch.",
        inputSchema: {
            type: "object",
            properties: {
                vault_path: {
                    type: "string",
                    description: "Optional vault path override",
                },
                workspace_path: {
                    type: "string",
                    description: "Optional workspace path override",
                },
                vault_id: {
                    type: "string",
                    description: "Optional unique identifier for the vault",
                },
                file_path: {
                    type: "string",
                    description: "Relative path to a specific note to re-index",
                },
                force_reindex: {
                    type: "boolean",
                    description:
                        "Force full re-index, ignoring cached file hashes (default: false)",
                },
            },
        },
        async handler(args, context) {
            const vaultPath = context.getVaultPath(args.vault_path);
            const workspacePath = context.getWorkspacePath(args.workspace_path);
            const vaultId = context.getVaultId(args.vault_id);
            const filePath = args.file_path ? String(args.file_path) : null;
            const force = booleanArg(args.force_reindex) || booleanArg(args.force);
            const result = filePath
                ? await context.indexer.indexFile(
                    vaultPath,
                    filePath,
                    workspacePath,
                    vaultId,
                )
                : await context.indexer.indexVault(
                    vaultPath,
                    force,
                    workspacePath,
                    vaultId,
                );
            return JSON.stringify(result);
        },
    },
    {
        name: "obsidian_rag_query",
        description:
            "Perform graph-aware semantic search on the indexed vault. Supports optional entity/community filters and returns clean chunk content with heading breadcrumbs.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Question or query to ask your notes",
                },
                limit: {
                    type: "number",
                    description: "Number of chunks to retrieve (default 5)",
                },
                vault_path: {
                    type: "string",
                    description: "Optional vault path override",
                },
                workspace_path: {
                    type: "string",
                    description: "Optional workspace path override",
                },
                vault_id: {
                    type: "string",
                    description: "Optional unique identifier for the vault",
                },
                entities: {
                    type: "array",
                    description: "Optional entity labels to require in matching chunks. Matched exactly (case-sensitive); comma-separated for CLI",
                    items: { type: "string" },
                },
                communities: {
                    type: "array",
                    description: "Optional community labels to require in matching chunks. Matched exactly (case-sensitive); comma-separated for CLI",
                    items: { type: "string" },
                },
            },
            required: ["query"],
        },
        async handler(args, context) {
            const query = String(args.query);
            const limit = Number(args.limit) || 5;
            const vaultPath = context.getVaultPath(args.vault_path);
            const workspacePath = context.getWorkspacePath(args.workspace_path);
            const vaultId = context.getVaultId(args.vault_id);
            const filters = {
                entities: stringArrayArg("entities", args.entities),
                communities: stringArrayArg("communities", args.communities),
            };
            const [staleness, results] = await Promise.all([
                context.indexer.checkIndexStaleness(vaultPath, workspacePath, vaultId),
                context.indexer.search(query, vaultPath, limit, workspacePath, vaultId, filters),
            ]);
            const text = results
                .map((result) => {
                    const heading = typeof result.heading_path === "string" && result.heading_path.length > 0
                        ? `\nHeading: ${result.heading_path}`
                        : "";
                    return `---\nFile: ${result.path}${heading}\nRelevance: ${result._relevance_score ?? result._distance}\nContent: ${result.text}\n---`;
                })
                .join("\n");
            const staleNotice = staleness.stale
                ? `Index may be stale (${staleness.reason ?? "vault files changed"}). Run obsidian_rag_index to refresh.`
                : "";
            return [text, staleNotice].filter((part) => part.length > 0).join("\n\n");
        },
    },
    {
        name: "obsidian_get_backlinks",
        description: "Find all notes that link to a specific note.",
        inputSchema: {
            type: "object",
            properties: {
                file_name: {
                    type: "string",
                    description:
                        "Name of the note to find backlinks for (without extension)",
                },
                vault_path: {
                    type: "string",
                    description: "Optional vault path override",
                },
            },
            required: ["file_name"],
        },
        async handler(args, context) {
            const vaultPath = context.getVaultPath(args.vault_path);
            const target = String(args.file_name).replace(/\.md$/i, "");
            const linkRegex = new RegExp(
                `\\[\\[${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\]\\|#])`,
                "i",
            );
            const files = filterSafeVaultFiles(
                vaultPath,
                await glob("**/*.md", { cwd: vaultPath, follow: true }),
            );
            const backlinks: string[] = [];
            const batchSize = 50;

            for (let i = 0; i < files.length; i += batchSize) {
                const batch = files.slice(i, i + batchSize);
                await Promise.all(
                    batch.map(async (file) => {
                        try {
                            const content = await fs.readFile(
                                getSafeFilePath(vaultPath, file),
                                "utf-8",
                            );
                            if (linkRegex.test(content)) {
                                backlinks.push(file);
                            }
                        } catch {
                            /* ignore unreadable files */
                        }
                    }),
                );
            }

            if (backlinks.length === 0) {
                return `No backlinks found for "[[${target}]]".`;
            }
            return (
                `Found ${backlinks.length} backlinks for "[[${target}]]":\n` +
                backlinks.map((file) => `- ${file}`).join("\n")
            );
        },
    },
    {
        name: "obsidian_get_links",
        description: "Get all outgoing links from a specific note.",
        inputSchema: {
            type: "object",
            properties: {
                file_path: {
                    type: "string",
                    description: "Relative path to the note",
                },
                vault_path: {
                    type: "string",
                    description: "Optional vault path override",
                },
            },
            required: ["file_path"],
        },
        async handler(args, context) {
            const vaultPath = context.getVaultPath(args.vault_path);
            const filePath = getSafeFilePath(vaultPath, String(args.file_path));
            const content = await fs.readFile(filePath, "utf-8");
            return JSON.stringify(extractWikilinks(content), null, 2);
        },
    },
    {
        name: "obsidian_move_note",
        description: "Move or rename a note.",
        inputSchema: {
            type: "object",
            properties: {
                source_path: {
                    type: "string",
                    description: "Current relative path of the note",
                },
                dest_path: {
                    type: "string",
                    description:
                        'New relative path for the note (e.g. "Archive/OldNote.md")',
                },
                vault_path: {
                    type: "string",
                    description: "Optional vault path override",
                },
                workspace_path: {
                    type: "string",
                    description: "Optional workspace path override",
                },
                vault_id: {
                    type: "string",
                    description: "Optional unique identifier for the vault",
                },
                overwrite: {
                    type: "boolean",
                    description:
                        "Overwrite the destination note if it already exists (default: false)",
                },
            },
            required: ["source_path", "dest_path"],
        },
        async handler(args, context) {
            const vaultPath = context.getVaultPath(args.vault_path);
            const workspacePath = context.getWorkspacePath(args.workspace_path);
            const vaultId = context.getVaultId(args.vault_id);
            const sourceRelativePath = String(args.source_path);
            const destRelativePath = String(args.dest_path);
            const source = getSafeFilePath(vaultPath, sourceRelativePath);
            const dest = getSafeFilePath(vaultPath, destRelativePath);
            const overwrite = booleanArg(args.overwrite);

            if (!overwrite) {
                try {
                    await fs.stat(dest);
                    throw new Error(
                        `Destination note already exists: ${destRelativePath}. Set overwrite=true to replace it.`,
                    );
                } catch (error: any) {
                    if (error?.code !== "ENOENT") throw error;
                }
            }

            await fs.mkdir(path.dirname(dest), { recursive: true });
            await fs.rename(source, dest);
            await reindexMovedNote(
                context,
                vaultPath,
                sourceRelativePath,
                destRelativePath,
                workspacePath,
                vaultId,
            );
            return `Moved ${args.source_path} to ${args.dest_path}`;
        },
    },
    {
        name: "obsidian_update_frontmatter",
        description:
            "Update YAML frontmatter of a note safely. Supports single key/value or batch updates.",
        inputSchema: {
            type: "object",
            properties: {
                file_path: {
                    type: "string",
                    description: "Relative path to the note",
                },
                key: {
                    type: "string",
                    description: "Frontmatter key to update (single-key mode)",
                },
                value: {
                    type: "string",
                    description:
                        "New value for the key (JSON stringified if array/object; single-key mode)",
                },
                updates: {
                    type: "object",
                    description:
                        "JSON object of key/value pairs to set at once (batch mode, alternative to key+value)",
                },
                vault_path: {
                    type: "string",
                    description: "Optional vault path override",
                },
                workspace_path: {
                    type: "string",
                    description: "Optional workspace path override",
                },
                vault_id: {
                    type: "string",
                    description: "Optional unique identifier for the vault",
                },
            },
            required: ["file_path"],
        },
        async handler(args, context) {
            const vaultPath = context.getVaultPath(args.vault_path);
            const workspacePath = context.getWorkspacePath(args.workspace_path);
            const vaultId = context.getVaultId(args.vault_id);
            const relativePath = String(args.file_path);
            const filePath = getSafeFilePath(vaultPath, relativePath);
            const fileContent = await fs.readFile(filePath, "utf-8");
            let updateArg: Parameters<typeof applyFrontmatterUpdate>[1];
            if (args.updates) {
                const updates =
                    typeof args.updates === "string"
                        ? JSON.parse(args.updates)
                        : args.updates;
                updateArg = { updates: updates as Record<string, unknown> };
            } else {
                updateArg = {
                    key: String(args.key),
                    value: String(args.value),
                };
            }
            await fs.writeFile(
                filePath,
                applyFrontmatterUpdate(fileContent, updateArg),
                "utf-8",
            );
            await reindexNoteAfterWrite(
                context,
                vaultPath,
                relativePath,
                workspacePath,
                vaultId,
            );
            return `Updated frontmatter in ${args.file_path}`;
        },
    },
    {
        name: "obsidian_replace_section",
        description:
            "Replace the body under a heading (up to the next heading of equal/higher level, or EOF). The heading line itself is preserved.",
        inputSchema: {
            type: "object",
            properties: {
                file_path: {
                    type: "string",
                    description: "Relative path to the note",
                },
                heading: {
                    type: "string",
                    description: 'Heading text to find (e.g. "Status")',
                },
                content: {
                    type: "string",
                    description:
                        "New section body (replaces everything between heading and next same/higher-level heading)",
                },
                vault_path: {
                    type: "string",
                    description: "Optional vault path override",
                },
                workspace_path: {
                    type: "string",
                    description: "Optional workspace path override",
                },
                vault_id: {
                    type: "string",
                    description: "Optional unique identifier for the vault",
                },
            },
            required: ["file_path", "heading", "content"],
        },
        async handler(args, context) {
            const vaultPath = context.getVaultPath(args.vault_path);
            const workspacePath = context.getWorkspacePath(args.workspace_path);
            const vaultId = context.getVaultId(args.vault_id);
            const relativePath = String(args.file_path);
            const filePath = getSafeFilePath(vaultPath, relativePath);
            const heading = String(args.heading);
            const content = String(args.content);
            const fileContent = await fs.readFile(filePath, "utf-8");
            const range = findSectionRange(fileContent, heading);
            if (!range) {
                throw new Error(`Heading "${heading}" not found in ${args.file_path}`);
            }
            await fs.writeFile(
                filePath,
                replaceSection(fileContent, range, content),
                "utf-8",
            );
            await reindexNoteAfterWrite(
                context,
                vaultPath,
                relativePath,
                workspacePath,
                vaultId,
            );
            return `Replaced section "${heading}" in ${args.file_path}`;
        },
    },
    {
        name: "obsidian_insert_at_heading",
        description:
            "Insert content under a specific heading. If heading not found, appends it as a new ## section.",
        inputSchema: {
            type: "object",
            properties: {
                file_path: {
                    type: "string",
                    description: "Relative path to the note",
                },
                heading: {
                    type: "string",
                    description: 'Heading text to find (e.g. "Notes")',
                },
                content: { type: "string", description: "Text to insert" },
                position: {
                    type: "string",
                    enum: ["beginning", "end"],
                    description: "Insert at beginning or end of section (default: end)",
                },
                vault_path: {
                    type: "string",
                    description: "Optional vault path override",
                },
                workspace_path: {
                    type: "string",
                    description: "Optional workspace path override",
                },
                vault_id: {
                    type: "string",
                    description: "Optional unique identifier for the vault",
                },
            },
            required: ["file_path", "heading", "content"],
        },
        async handler(args, context) {
            const vaultPath = context.getVaultPath(args.vault_path);
            const workspacePath = context.getWorkspacePath(args.workspace_path);
            const vaultId = context.getVaultId(args.vault_id);
            const relativePath = String(args.file_path);
            const filePath = getSafeFilePath(vaultPath, relativePath);
            const heading = String(args.heading);
            const content = String(args.content);
            const position = (args.position || "end") as "beginning" | "end";
            const fileContent = await fs.readFile(filePath, "utf-8");
            const range = findSectionRange(fileContent, heading);
            await fs.writeFile(
                filePath,
                insertAtHeading(fileContent, heading, content, position, range),
                "utf-8",
            );
            await reindexNoteAfterWrite(
                context,
                vaultPath,
                relativePath,
                workspacePath,
                vaultId,
            );
            return `Inserted content under "${heading}" in ${args.file_path}`;
        },
    },
    {
        name: "obsidian_replace_in_note",
        description:
            "Replace the first occurrence of a specific text string in a note. Use for surgical inline edits, e.g. adding a wikilink to existing text.",
        inputSchema: {
            type: "object",
            properties: {
                file_path: {
                    type: "string",
                    description: "Relative path to the note",
                },
                old_text: {
                    type: "string",
                    description: "Exact text to find and replace",
                },
                new_text: {
                    type: "string",
                    description: "Replacement text (default: empty string)",
                },
                vault_path: {
                    type: "string",
                    description: "Optional vault path override",
                },
                workspace_path: {
                    type: "string",
                    description: "Optional workspace path override",
                },
                vault_id: {
                    type: "string",
                    description: "Optional unique identifier for the vault",
                },
            },
            required: ["file_path", "old_text"],
        },
        async handler(args, context) {
            const vaultPath = context.getVaultPath(args.vault_path);
            const workspacePath = context.getWorkspacePath(args.workspace_path);
            const vaultId = context.getVaultId(args.vault_id);
            const relativePath = String(args.file_path);
            const filePath = getSafeFilePath(vaultPath, relativePath);
            const fileContent = await fs.readFile(filePath, "utf-8");
            const updated = replaceInNote(
                fileContent,
                String(args.old_text),
                String(args.new_text ?? ""),
            );
            await fs.writeFile(filePath, updated, "utf-8");
            await reindexNoteAfterWrite(
                context,
                vaultPath,
                relativePath,
                workspacePath,
                vaultId,
            );
            return `Replaced text in ${args.file_path}`;
        },
    },
    {
        name: "obsidian_get_broken_links",
        description:
            "Find all wikilinks in the vault (or a subfolder) that point to non-existent notes. Returns broken links grouped by source file.",
        inputSchema: {
            type: "object",
            properties: {
                subfolder: {
                    type: "string",
                    description:
                        "Limit scan to this subfolder (optional; default: entire vault)",
                },
                vault_path: {
                    type: "string",
                    description: "Optional vault path override",
                },
            },
        },
        async handler(args, context) {
            const vaultPath = context.getVaultPath(args.vault_path);
            const pattern = listNotesPattern(optionalString(args.subfolder));
            const files = filterSafeVaultFiles(
                vaultPath,
                await glob(pattern, { cwd: vaultPath, follow: true }),
            );
            const allFiles = filterSafeVaultFiles(
                vaultPath,
                await glob("**/*.md", { cwd: vaultPath, follow: true }),
            );
            const nameSet = new Set(
                allFiles.map((file) => path.basename(file, ".md").toLowerCase()),
            );
            const targetMap = new Map<string, string[]>();
            for (const file of files) {
                const content = await fs
                    .readFile(getSafeFilePath(vaultPath, file), "utf-8")
                    .catch(() => "");
                for (const link of extractWikilinks(content)) {
                    const target = stripHeadingFromLink(link);
                    if (!target) continue;
                    const refs = targetMap.get(target) ?? [];
                    refs.push(file);
                    targetMap.set(target, refs);
                }
            }
            const broken: Array<{ target: string; refs: string[] }> = [];
            for (const [target, refs] of targetMap) {
                if (!nameSet.has(target.toLowerCase())) {
                    broken.push({ target, refs });
                }
            }
            if (broken.length === 0) {
                return "No broken links found.";
            }
            const lines = broken
                .map((entry) => `[[${entry.target}]] — in: ${entry.refs.join(", ")}`)
                .join("\n");
            return `Found ${broken.length} broken link(s):\n${lines}`;
        },
    },
];

export const obsidianToolMap = new Map(
    obsidianTools.map((tool) => [tool.name, tool]),
);

export function getTool(name: string): ObsidianTool | undefined {
    return obsidianToolMap.get(name);
}

export function getKnownToolNames(): string[] {
    return obsidianTools.map((tool) => tool.name);
}

export async function callRegistryTool(
    name: string,
    args: ToolArguments | undefined,
    context: ToolContext,
): Promise<string> {
    const tool = getTool(name);
    if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
    }
    return tool.handler(args ?? {}, context);
}
