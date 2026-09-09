import type { SearchFilters } from "../rag/store.js";

export type JsonSchema = {
    type: string;
    properties?: Record<string, JsonSchemaProperty>;
    required?: string[];
};

export type JsonSchemaProperty = {
    type: string;
    description?: string;
    enum?: string[];
    items?: {
        type: string;
    };
};

export type ToolArguments = Record<string, unknown>;

export interface VaultIndexerLike {
    reset(): Promise<void>;
    indexFile(
        vaultPath: string,
        relativePath: string,
        workspacePath?: string | null,
        vaultId?: string | null,
    ): Promise<unknown>;
    indexVault(
        vaultPath: string,
        force?: boolean,
        workspacePath?: string | null,
        vaultId?: string | null,
        maintenance?: boolean,
    ): Promise<unknown>;
    moveFile(
        vaultPath: string,
        sourceRelativePath: string,
        destRelativePath: string,
        workspacePath?: string | null,
        vaultId?: string | null,
    ): Promise<unknown>;
    checkIndexStaleness(
        vaultPath: string,
        workspacePath?: string | null,
        vaultId?: string | null,
    ): Promise<{ stale: boolean; reason?: string }>;
    search(
        query: string,
        vaultPath: string,
        limit?: number,
        workspacePath?: string | null,
        vaultId?: string | null,
        filters?: SearchFilters,
    ): Promise<Array<Record<string, unknown>>>;
}

export interface ToolConfig {
    vault_path: string | null;
    workspace_path: string | null;
    vault_id: string | null;
}

export interface SetConfigOptions {
    vaultPath: string;
    workspacePath?: string | null;
    vaultId?: string | null;
}

export interface ToolContext {
    indexer: VaultIndexerLike;
    getVaultPath(providedPath?: unknown): string;
    getWorkspacePath(providedPath?: unknown): string | null;
    getVaultId(providedId?: unknown): string | null;
    getConfig(): ToolConfig;
    setConfig(options: SetConfigOptions): Promise<void>;
}

export interface ObsidianTool {
    name: string;
    description: string;
    inputSchema: JsonSchema;
    handler(args: ToolArguments, context: ToolContext): Promise<string>;
}
