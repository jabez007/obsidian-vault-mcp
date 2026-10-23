import type { SearchFilters } from "../rag/store.js";
import type { NotePolicy } from "../note-policy.js";

export type JsonSchema = {
    type: string;
    properties?: Record<string, JsonSchemaProperty>;
    required?: string[];
};

export type JsonSchemaProperty = {
    type: string | string[];
    description?: string;
    minLength?: number;
    pattern?: string;
    enum?: string[];
    items?: {
        type: string;
    };
};

export type ToolArguments = Record<string, unknown>;

export interface VaultIndexerLike {
    reset(): Promise<void>;
    prepareIndexSnapshot(
        vaultPath: string,
        workspacePath?: string | null,
        vaultId?: string | null,
        rulesText?: string,
    ): Promise<unknown>;
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
    notePolicy?: NotePolicy;
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
    /** At least one group must be complete. Kept outside schemas for MCP host compatibility. */
    requiredArgumentGroups?: string[][];
    handler(args: ToolArguments, context: ToolContext): Promise<string>;
}
