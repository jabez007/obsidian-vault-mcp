#!/usr/bin/env node

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { getDailyNoteConfig } from "./daily-note.js";
import {
    dispatchCliTool,
    dispatchMcpTool,
    listToolsResponse,
} from "./tools/dispatch.js";
import type {
    SetConfigOptions,
    ToolConfig,
    ToolContext,
    VaultIndexerLike,
} from "./tools/types.js";

export { getDailyNoteConfig };

const CONFIG_PATHS = [
    path.join(os.homedir(), ".obsidian-mcp.config.json"),
];
const LEGACY_CONFIG_PATHS = [
    path.join(os.homedir(), ".gemini-obsidian.config.json"),
];
const PROJECT_NAME = "obsidian-vault-mcp";

function assertNativeDependencies() {
    try {
        require.resolve("@lancedb/lancedb");
        require.resolve("@huggingface/transformers");
    } catch {
        console.error(
            "\n[Obsidian MCP] Error: Required native dependencies are missing.",
        );
        console.error('This usually means the published package install did not complete.');
        console.error(
            "Launch the server through npm so dependencies are installed automatically:",
        );
        console.error("  npx -y @jabez007/obsidian-vault-mcp@2\n");
        console.error("For local development, run: npm install && npm run build\n");
        process.exit(1);
    }
}

function getFirstEnv(...keys: string[]): string | null {
    for (const key of keys) {
        const value = process.env[key];
        if (typeof value === "string" && value.length > 0) {
            return value;
        }
    }
    return null;
}

async function saveConfig(options: SetConfigOptions) {
    try {
        const serialized = JSON.stringify({
            vault_path: options.vaultPath,
            workspace_path: options.workspacePath ?? null,
            vault_id: options.vaultId ?? null,
        });
        await Promise.all(
            CONFIG_PATHS.map((configPath) =>
                fs.writeFile(configPath, serialized, "utf-8"),
            ),
        );
    } catch (error) {
        console.error("Failed to save config", error);
    }
}

async function loadConfig(): Promise<ToolConfig> {
    for (const configPath of [...CONFIG_PATHS, ...LEGACY_CONFIG_PATHS]) {
        try {
            const data = await fs.readFile(configPath, "utf-8");
            const config = JSON.parse(data);
            return {
                vault_path: config.vault_path || null,
                workspace_path: config.workspace_path || null,
                vault_id: config.vault_id || null,
            };
        } catch {
            continue;
        }
    }
    return {
        vault_path: null,
        workspace_path: null,
        vault_id: null,
    };
}

async function loadPackageMetadata(): Promise<{ name: string; version: string }> {
    const packageJsonPath = path.join(__dirname, "..", "package.json");
    try {
        const data = await fs.readFile(packageJsonPath, "utf-8");
        const packageJson = JSON.parse(data);
        return {
            name: String(packageJson.name || PROJECT_NAME),
            version: String(packageJson.version || "0.0.0"),
        };
    } catch {
        return { name: PROJECT_NAME, version: "0.0.0" };
    }
}

function createToolContext(
    indexer: VaultIndexerLike,
    initialConfig: ToolConfig,
): ToolContext {
    const config: ToolConfig = { ...initialConfig };

    return {
        indexer,
        getVaultPath(providedPath?: unknown) {
            const vaultPath =
                typeof providedPath === "string" && providedPath.length > 0
                    ? providedPath
                    : config.vault_path;
            if (!vaultPath) {
                throw new Error(
                    "Vault path is not set. Use obsidian_set_vault or provide 'vault_path' argument.",
                );
            }
            return vaultPath;
        },
        getWorkspacePath(providedPath?: unknown) {
            return typeof providedPath === "string" && providedPath.length > 0
                ? providedPath
                : config.workspace_path;
        },
        getVaultId(providedId?: unknown) {
            return typeof providedId === "string" && providedId.length > 0
                ? providedId
                : config.vault_id;
        },
        getConfig() {
            return { ...config };
        },
        async setConfig(options: SetConfigOptions) {
            config.vault_path = options.vaultPath;
            config.workspace_path = options.workspacePath ?? null;
            config.vault_id = options.vaultId ?? null;
            await indexer.reset();
            await saveConfig(options);
        },
    };
}

async function readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = "";
        process.stdin.setEncoding("utf-8");
        process.stdin.on("data", (chunk) => {
            data += chunk;
        });
        process.stdin.on("end", () => {
            resolve(data);
        });
        process.stdin.on("error", (error) => {
            reject(error);
        });
        setTimeout(() => {
            if (data === "") {
                resolve("");
            }
        }, 1000);
    });
}

async function buildInitialConfig(): Promise<ToolConfig> {
    const envConfig: ToolConfig = {
        vault_path: getFirstEnv(
            "OBSIDIAN_VAULT_PATH",
            "CODEX_OBSIDIAN_VAULT_PATH",
            "GEMINI_OBSIDIAN_VAULT_PATH",
        ),
        workspace_path: getFirstEnv(
            "OBSIDIAN_WORKSPACE_PATH",
            "CODEX_OBSIDIAN_WORKSPACE_PATH",
            "GEMINI_OBSIDIAN_WORKSPACE_PATH",
        ),
        vault_id: getFirstEnv(
            "OBSIDIAN_VAULT_ID",
            "CODEX_OBSIDIAN_VAULT_ID",
            "GEMINI_OBSIDIAN_VAULT_ID",
        ),
    };
    const storedConfig = await loadConfig();
    return {
        vault_path: envConfig.vault_path || storedConfig.vault_path,
        workspace_path: envConfig.workspace_path || storedConfig.workspace_path,
        vault_id: envConfig.vault_id || storedConfig.vault_id,
    };
}

export async function main() {
    assertNativeDependencies();

    const [
        { Server },
        { StdioServerTransport },
        { CallToolRequestSchema, ListToolsRequestSchema },
        { VaultIndexer },
    ] = await Promise.all([
        import("@modelcontextprotocol/sdk/server/index.js"),
        import("@modelcontextprotocol/sdk/server/stdio.js"),
        import("@modelcontextprotocol/sdk/types.js"),
        import("./rag/store.js"),
    ]);

    const context = createToolContext(
        new VaultIndexer(),
        await buildInitialConfig(),
    );
    const packageMetadata = await loadPackageMetadata();

    const cliResult = await dispatchCliTool(
        process.argv.slice(2),
        context,
        readStdin,
    );
    if (cliResult.handled) {
        if (cliResult.output !== undefined) {
            if (cliResult.exitCode === 0) {
                console.log(cliResult.output);
            } else {
                console.error(cliResult.output);
            }
        }
        process.exit(cliResult.exitCode);
    }

    const server = new Server(
        {
            name: packageMetadata.name,
            version: packageMetadata.version,
        },
        {
            capabilities: {
                tools: {},
            },
        },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => listToolsResponse());

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        try {
            return await dispatchMcpTool(
                name,
                args as Record<string, unknown> | undefined,
                context,
            );
        } catch (error: any) {
            return {
                isError: true,
                content: [{ type: "text" as const, text: `Error: ${error.message}` }],
            };
        }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

if (require.main === module) {
    void main();
}
