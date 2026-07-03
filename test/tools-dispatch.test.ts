import { describe, expect, it, vi } from 'vitest';
import {
  dispatchCliTool,
  dispatchMcpTool,
  listToolsResponse,
} from '../src/tools/dispatch';
import type { ToolConfig, ToolContext, VaultIndexerLike } from '../src/tools/types';

function createFakeContext(configOverrides: Partial<ToolConfig> = {}) {
  const config: ToolConfig = {
    vault_path: '/vault',
    workspace_path: null,
    vault_id: null,
    ...configOverrides,
  };
  const indexer: VaultIndexerLike = {
    reset: vi.fn(async () => {}),
    indexFile: vi.fn(async () => ({ success: true, chunks: 1 })),
    indexVault: vi.fn(async () => ({ success: true, chunks: 2 })),
    moveFile: vi.fn(async () => ({ success: true, chunks: 1 })),
    search: vi.fn(async () => [
      { path: 'Notes/A.md', _relevance_score: 0.875, text: 'matched text' },
      { path: 'Notes/B.md', _distance: 0.125, text: 'fallback text' },
    ]),
  };

  const context: ToolContext = {
    indexer,
    getVaultPath(providedPath?: unknown) {
      const vaultPath =
        typeof providedPath === 'string' && providedPath.length > 0
          ? providedPath
          : config.vault_path;
      if (!vaultPath) throw new Error('Vault path is not set.');
      return vaultPath;
    },
    getWorkspacePath(providedPath?: unknown) {
      return typeof providedPath === 'string' && providedPath.length > 0
        ? providedPath
        : config.workspace_path;
    },
    getVaultId(providedId?: unknown) {
      return typeof providedId === 'string' && providedId.length > 0
        ? providedId
        : config.vault_id;
    },
    getConfig() {
      return { ...config };
    },
    async setConfig(options) {
      config.vault_path = options.vaultPath;
      config.workspace_path = options.workspacePath ?? null;
      config.vault_id = options.vaultId ?? null;
      await indexer.reset();
    },
  };

  return { context, indexer };
}

describe('tool registry dispatch', () => {
  it('generates the MCP tool list from the registry', () => {
    const response = listToolsResponse();
    expect(response.tools).toHaveLength(18);
    expect(response.tools.map((tool) => tool.name)).toContain('obsidian_rag_query');
    expect(response.tools.find((tool) => tool.name === 'obsidian_rag_index')?.inputSchema.properties?.force_reindex).toEqual({
      type: 'boolean',
      description: 'Force full re-index, ignoring cached file hashes (default: false)',
    });
  });

  it('dispatches MCP calls through the registry and includes RAG relevance', async () => {
    const { context, indexer } = createFakeContext();
    const result = await dispatchMcpTool(
      'obsidian_rag_query',
      { query: 'needle', limit: 3, vault_path: '/alt-vault' },
      context,
    );

    expect(indexer.search).toHaveBeenCalledWith('needle', '/alt-vault', 3, null, null);
    expect(result.content[0].text).toBe(
      '---\nFile: Notes/A.md\nRelevance: 0.875\nContent: matched text\n---\n' +
      '---\nFile: Notes/B.md\nRelevance: 0.125\nContent: fallback text\n---',
    );
  });

  it('dispatches CLI calls through the registry and parses boolean flag values', async () => {
    const { context, indexer } = createFakeContext();
    const result = await dispatchCliTool(
      ['obsidian_rag_index', '--vault_path', '/vault', '--force_reindex', 'true'],
      context,
      async () => '',
    );

    expect(result).toEqual({
      handled: true,
      exitCode: 0,
      output: JSON.stringify({ success: true, chunks: 2 }),
    });
    expect(indexer.indexVault).toHaveBeenCalledWith('/vault', true, null, null);
  });

  it('parses the legacy CLI --force boolean alias', async () => {
    const { context, indexer } = createFakeContext();
    await dispatchCliTool(
      ['obsidian_rag_index', '--vault_path', '/vault', '--force', 'true'],
      context,
      async () => '',
    );

    expect(indexer.indexVault).toHaveBeenCalledWith('/vault', true, null, null);
  });

  it('keeps the obsidian_rag_index --hook stdin mode', async () => {
    const { context, indexer } = createFakeContext();
    const result = await dispatchCliTool(
      ['obsidian_rag_index', '--hook'],
      context,
      async () => JSON.stringify({
        tool_input: {
          vault_path: '/vault',
          workspace_path: '/workspace',
          vault_id: 'main',
          file_path: 'Daily.md',
          force_reindex: true,
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(indexer.indexFile).toHaveBeenCalledWith('/vault', 'Daily.md', '/workspace', 'main');
  });

  it('prints the same RAG query text for CLI as MCP', async () => {
    const { context } = createFakeContext();
    const cliResult = await dispatchCliTool(
      ['obsidian_rag_query', '--query', 'needle'],
      context,
      async () => '',
    );
    const mcpResult = await dispatchMcpTool('obsidian_rag_query', { query: 'needle' }, context);

    expect(cliResult.output).toBe(mcpResult.content[0].text);
    expect(cliResult.output).toContain('Relevance: 0.125');
  });
});
