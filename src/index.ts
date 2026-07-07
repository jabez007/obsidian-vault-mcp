#!/usr/bin/env node

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { getDailyNoteConfig } from "./daily-note.js";
import {
    getFirstEnv,
    isPathContainedByRoot,
    parseAllowedVaultRoots,
    resolveRealPathAllowMissing,
} from "./utils.js";
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
        require.resolve("apache-arrow");
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

function boundaryViolation(
    pathKind: "vault_path" | "workspace_path",
    candidatePath: string,
): Error {
    return new Error(
        `Security Error: ${pathKind} is outside the allowed vault boundary: ${candidatePath}. ` +
        "Set OBSIDIAN_ALLOWED_VAULTS to permit additional roots.",
    );
}

function assertPathAllowed(
    candidatePath: string,
    allowedRoots: string[],
    pathKind: "vault_path" | "workspace_path",
) {
    const realCandidatePath = resolveRealPathAllowMissing(candidatePath);
    const realAllowedRoots = allowedRoots.map((rootPath) =>
        resolveRealPathAllowMissing(rootPath),
    );
    if (
        !realAllowedRoots.some((rootPath) =>
            isPathContainedByRoot(realCandidatePath, rootPath),
        )
    ) {
        throw boundaryViolation(pathKind, candidatePath);
    }
}

function assertPathMatches(
    candidatePath: string,
    allowedPath: string,
    pathKind: "vault_path" | "workspace_path",
) {
    const realCandidatePath = resolveRealPathAllowMissing(candidatePath);
    const realAllowedPath = resolveRealPathAllowMissing(allowedPath);
    if (realCandidatePath !== realAllowedPath) {
        throw boundaryViolation(pathKind, candidatePath);
    }
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

export function createToolContext(
    indexer: VaultIndexerLike,
    initialConfig: ToolConfig,
    contextOptions: { saveConfig?: (options: SetConfigOptions) => Promise<void> } = {},
): ToolContext {
    const config: ToolConfig = { ...initialConfig };
    const envAllowedRoots = parseAllowedVaultRoots();

    function assertVaultPathAllowed(vaultPath: string) {
        if (envAllowedRoots) {
            assertPathAllowed(vaultPath, envAllowedRoots, "vault_path");
            return;
        }
        if (!config.vault_path) return;
        assertPathMatches(vaultPath, config.vault_path, "vault_path");
    }

    function assertWorkspacePathAllowed(workspacePath: string | null) {
        if (!workspacePath) return;
        if (envAllowedRoots) {
            assertPathAllowed(workspacePath, envAllowedRoots, "workspace_path");
            return;
        }
        if (!config.vault_path && !config.workspace_path) return;
        if (!config.workspace_path) {
            throw boundaryViolation("workspace_path", workspacePath);
        }
        assertPathMatches(workspacePath, config.workspace_path, "workspace_path");
    }

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
            assertVaultPathAllowed(vaultPath);
            return vaultPath;
        },
        getWorkspacePath(providedPath?: unknown) {
            const workspacePath = typeof providedPath === "string" && providedPath.length > 0
                ? providedPath
                : config.workspace_path;
            assertWorkspacePathAllowed(workspacePath);
            return workspacePath;
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
            assertVaultPathAllowed(options.vaultPath);
            assertWorkspacePathAllowed(options.workspacePath ?? null);
            config.vault_path = options.vaultPath;
            config.workspace_path = options.workspacePath ?? null;
            config.vault_id = options.vaultId ?? null;
            await indexer.reset();
            await (contextOptions.saveConfig ?? saveConfig)(options);
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
