import {
    callRegistryTool,
    getKnownToolNames,
    getTool,
    obsidianTools,
} from "./registry.js";
import type { ObsidianTool, ToolArguments, ToolContext } from "./types.js";

const EXTRA_BOOLEAN_CLI_KEYS = new Set(["force", "hook"]);

export interface CliDispatchResult {
    handled: boolean;
    exitCode: number;
    output?: string;
}

export function listToolsResponse() {
    return {
        tools: obsidianTools.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
        })),
    };
}

export async function dispatchMcpTool(
    name: string,
    args: ToolArguments | undefined,
    context: ToolContext,
) {
    const text = await callRegistryTool(name, args, context);
    return { content: [{ type: "text" as const, text }] };
}

function getPropertyType(tool: ObsidianTool, key: string): string | undefined {
    return tool.inputSchema.properties?.[key]?.type;
}

function parseBoolean(value: unknown): boolean {
    if (value === true || value === false) return value;
    if (typeof value === "string") {
        const normalized = value.toLowerCase();
        if (normalized === "true") return true;
        if (normalized === "false") return false;
    }
    return Boolean(value);
}

function parseCliValue(tool: ObsidianTool, key: string, value: unknown): unknown {
    const propertyType = getPropertyType(tool, key);
    if (propertyType === "boolean" || EXTRA_BOOLEAN_CLI_KEYS.has(key)) {
        return parseBoolean(value);
    }
    if (propertyType === "number") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : value;
    }
    return value;
}

export function parseCliToolArgs(tool: ObsidianTool, rawArgs: string[]) {
    const parsedArgs: ToolArguments = {};
    for (let i = 0; i < rawArgs.length; i++) {
        const current = rawArgs[i];
        if (!current?.startsWith("--")) continue;

        const key = current.substring(2);
        if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith("--")) {
            parsedArgs[key] = parseCliValue(tool, key, rawArgs[i + 1]);
            i++;
        } else {
            parsedArgs[key] = parseCliValue(tool, key, true);
        }
    }
    return parsedArgs;
}

async function buildHookRagIndexArgs(
    input: string,
): Promise<ToolArguments | null> {
    if (!input) return null;
    const parsed = JSON.parse(input);
    const toolInput = parsed.tool_input ?? {};
    if (!toolInput.file_path) return null;
    return {
        vault_path: toolInput.vault_path,
        workspace_path: toolInput.workspace_path,
        vault_id: toolInput.vault_id,
        file_path: toolInput.file_path,
        force_reindex: parseBoolean(toolInput.force_reindex),
    };
}

export async function dispatchCliTool(
    argv: string[],
    context: ToolContext,
    readStdin: () => Promise<string>,
): Promise<CliDispatchResult> {
    if (argv.length === 0 || !getKnownToolNames().includes(argv[0])) {
        return { handled: false, exitCode: 0 };
    }

    const toolName = argv[0];
    const tool = getTool(toolName);
    if (!tool) {
        return {
            handled: true,
            exitCode: 1,
            output: `Unknown tool: ${toolName}`,
        };
    }

    try {
        const parsedArgs = parseCliToolArgs(tool, argv.slice(1));
        const args =
            toolName === "obsidian_rag_index" && parsedArgs.hook
                ? await buildHookRagIndexArgs(await readStdin())
                : parsedArgs;

        if (!args) {
            return { handled: true, exitCode: 0 };
        }

        return {
            handled: true,
            exitCode: 0,
            output: await callRegistryTool(toolName, args, context),
        };
    } catch (error: any) {
        return {
            handled: true,
            exitCode: 1,
            output: error.message,
        };
    }
}
