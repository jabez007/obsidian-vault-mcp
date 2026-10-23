import { cliArgumentSchemas, ToolArgumentError } from "./arguments.js";
import { NotePolicyError } from "../note-policy.js";
import {
    callRegistryTool,
    getKnownToolNames,
    getTool,
    obsidianTools,
} from "./registry.js";
import type { ObsidianTool, ToolArguments, ToolContext } from "./types.js";

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
    let text: string;
    try { text = await callRegistryTool(name, args, context); } catch (error) {
        if (!(error instanceof NotePolicyError) && !(error instanceof ToolArgumentError)) throw error;
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: { code: error.code, message: error.message } }) }], isError: true };
    }
    if (["obsidian_prepare_index_snapshot", "obsidian_rag_index"].includes(name) && JSON.parse(text).success === false) {
        return { content: [{ type: "text" as const, text }], isError: true };
    }
    return { content: [{ type: "text" as const, text }] };
}

function parseBoolean(value: unknown): boolean {
    if (value === true || value === false) return value;
    if (typeof value === "string") {
        if (value.toLowerCase() === "true") return true;
        if (value.toLowerCase() === "false") return false;
    }
    throw new Error("must be true or false");
}

function parseCliValue(tool: ObsidianTool, key: string, value: unknown): unknown {
    const schema = cliArgumentSchemas(tool)[key];
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    try {
        if (types.includes("boolean")) return parseBoolean(value);
        if (types.includes("number")) {
            if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Number(value))) throw new Error("must be a finite number");
            return Number(value);
        }
        if (types.includes("array")) return String(value).split(",").map(item => item.trim()).filter(Boolean);
        if (types.includes("object")) return JSON.parse(String(value));
        return value;
    } catch (error) {
        throw new ToolArgumentError(tool.name, `${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function toolHelp(tool: ObsidianTool): string {
    const required = new Set(tool.inputSchema.required ?? []);
    return [
        `Usage: obsidian-vault-mcp ${tool.name} [options]`, tool.description, "", "Options:",
        ...Object.entries(cliArgumentSchemas(tool)).map(([key, schema]) =>
            `  --${key} (${[schema.type].flat().join(" or ")}${required.has(key) ? ", required" : ""}) ${schema.description ?? ""}`),
        "  --help  Show this help without running the tool.",
    ].join("\n");
}

export function parseCliToolArgs(tool: ObsidianTool, rawArgs: string[]) {
    const parsedArgs: ToolArguments = {};
    const schemas = cliArgumentSchemas(tool);
    for (let i = 0; i < rawArgs.length; i++) {
        const current = rawArgs[i];
        if (!current?.startsWith("--")) throw new ToolArgumentError(tool.name, `Unexpected argument: ${current}`);

        const equalsIndex = current.indexOf("=");
        const key = current.substring(2, equalsIndex === -1 ? undefined : equalsIndex);
        if (!Object.hasOwn(schemas, key)) throw new ToolArgumentError(tool.name, `Unknown option --${key}`);
        if (equalsIndex !== -1) {
            parsedArgs[key] = parseCliValue(tool, key, current.substring(equalsIndex + 1));
            continue;
        }
        if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith("--")) {
            parsedArgs[key] = parseCliValue(tool, key, rawArgs[i + 1]);
            i++;
        } else {
            const types = [schemas[key].type].flat();
            if (!types.includes("boolean")) {
                throw new ToolArgumentError(tool.name, `--${key} requires a value. Use --${key}=VALUE for values beginning with --.`);
            }
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
        force_reindex: parseCliValue(getTool("obsidian_rag_index")!, "force_reindex", toolInput.force_reindex ?? false),
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
        if (argv.length === 2 && ["--help", "-h"].includes(argv[1])) {
            return { handled: true, exitCode: 0, output: toolHelp(tool) };
        }
        const parsedArgs = parseCliToolArgs(tool, argv.slice(1));
        const args =
            toolName === "obsidian_rag_index" && parsedArgs.hook
                ? await buildHookRagIndexArgs(await readStdin())
                : parsedArgs;

        if (!args) {
            return { handled: true, exitCode: 0 };
        }

        const output = await callRegistryTool(toolName, args, context);
        return {
            handled: true,
            exitCode: ["obsidian_prepare_index_snapshot", "obsidian_rag_index"].includes(toolName) && JSON.parse(output).success === false ? 1 : 0,
            output,
        };
    } catch (error: any) {
        return {
            handled: true,
            exitCode: 1,
            output: error.message,
        };
    }
}
