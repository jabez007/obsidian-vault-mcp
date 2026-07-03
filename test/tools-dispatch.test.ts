import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createToolContext } from '../src/index';
import {
  dispatchCliTool,
  dispatchMcpTool,
  listToolsResponse,
} from '../src/tools/dispatch';
import type { ToolConfig, VaultIndexerLike } from '../src/tools/types';

const allowedVaultEnvKeys = [
  'OBSIDIAN_ALLOWED_VAULTS',
  'CODEX_OBSIDIAN_ALLOWED_VAULTS',
  'GEMINI_OBSIDIAN_ALLOWED_VAULTS',
] as const;
const originalAllowedVaultEnv = Object.fromEntries(
  allowedVaultEnvKeys.map((key) => [key, process.env[key]]),
);
let tempDirs: string[] = [];

async function makeTempDir(prefix: string) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

async function createFakeContext(configOverrides: Partial<ToolConfig> = {}) {
  const vaultPath = Object.prototype.hasOwnProperty.call(configOverrides, 'vault_path')
    ? configOverrides.vault_path ?? null
    : await makeTempDir('vault-dispatch-');
  const config: ToolConfig = {
    vault_path: vaultPath,
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

  const context = createToolContext(indexer, config, {
    saveConfig: vi.fn(async () => {}),
  });

  return { context, indexer, vaultPath };
}

describe('tool registry dispatch', () => {
  beforeEach(() => {
    for (const key of allowedVaultEnvKeys) {
      delete process.env[key];
    }
    tempDirs = [];
  });

  afterEach(async () => {
    for (const tempDir of tempDirs.reverse()) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    for (const key of allowedVaultEnvKeys) {
      const originalValue = originalAllowedVaultEnv[key];
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
  });

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
    const allowedRoot = await makeTempDir('allowed-vaults-');
    const vaultPath = path.join(allowedRoot, 'vault');
    const altVaultPath = path.join(allowedRoot, 'alt-vault');
    await fs.mkdir(vaultPath);
    await fs.mkdir(altVaultPath);
    process.env.OBSIDIAN_ALLOWED_VAULTS = allowedRoot;
    const { context, indexer } = await createFakeContext({ vault_path: vaultPath });
    const result = await dispatchMcpTool(
      'obsidian_rag_query',
      { query: 'needle', limit: 3, vault_path: altVaultPath },
      context,
    );

    expect(indexer.search).toHaveBeenCalledWith('needle', altVaultPath, 3, null, null);
    expect(result.content[0].text).toBe(
      '---\nFile: Notes/A.md\nRelevance: 0.875\nContent: matched text\n---\n' +
      '---\nFile: Notes/B.md\nRelevance: 0.125\nContent: fallback text\n---',
    );
  });

  it('dispatches CLI calls through the registry and parses boolean flag values', async () => {
    const { context, indexer, vaultPath } = await createFakeContext();
    const result = await dispatchCliTool(
      ['obsidian_rag_index', '--vault_path', vaultPath, '--force_reindex', 'true'],
      context,
      async () => '',
    );

    expect(result).toEqual({
      handled: true,
      exitCode: 0,
      output: JSON.stringify({ success: true, chunks: 2 }),
    });
    expect(indexer.indexVault).toHaveBeenCalledWith(vaultPath, true, null, null);
  });

  it('parses the legacy CLI --force boolean alias', async () => {
    const { context, indexer, vaultPath } = await createFakeContext();
    await dispatchCliTool(
      ['obsidian_rag_index', '--vault_path', vaultPath, '--force', 'true'],
      context,
      async () => '',
    );

    expect(indexer.indexVault).toHaveBeenCalledWith(vaultPath, true, null, null);
  });

  it('keeps the obsidian_rag_index --hook stdin mode', async () => {
    const workspacePath = await makeTempDir('workspace-dispatch-');
    const { context, indexer, vaultPath } = await createFakeContext({ workspace_path: workspacePath });
    const result = await dispatchCliTool(
      ['obsidian_rag_index', '--hook'],
      context,
      async () => JSON.stringify({
        tool_input: {
          vault_path: vaultPath,
          workspace_path: workspacePath,
          vault_id: 'main',
          file_path: 'Daily.md',
          force_reindex: true,
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(indexer.indexFile).toHaveBeenCalledWith(vaultPath, 'Daily.md', workspacePath, 'main');
  });

  it('prints the same RAG query text for CLI as MCP', async () => {
    const { context } = await createFakeContext();
    const cliResult = await dispatchCliTool(
      ['obsidian_rag_query', '--query', 'needle'],
      context,
      async () => '',
    );
    const mcpResult = await dispatchMcpTool('obsidian_rag_query', { query: 'needle' }, context);

    expect(cliResult.output).toBe(mcpResult.content[0].text);
    expect(cliResult.output).toContain('Relevance: 0.125');
  });

  it('rejects vault and workspace overrides outside OBSIDIAN_ALLOWED_VAULTS', async () => {
    const allowedRoot = await makeTempDir('allowed-vaults-');
    const vaultPath = path.join(allowedRoot, 'vault');
    const outOfBoundsVault = await makeTempDir('outside-vault-');
    const outOfBoundsWorkspace = await makeTempDir('outside-workspace-');
    await fs.mkdir(vaultPath);
    process.env.OBSIDIAN_ALLOWED_VAULTS = allowedRoot;
    const { context } = await createFakeContext({ vault_path: vaultPath });

    await expect(dispatchMcpTool(
      'obsidian_rag_query',
      { query: 'needle', vault_path: outOfBoundsVault },
      context,
    )).rejects.toThrow(/vault_path is outside the allowed vault boundary/);

    await expect(dispatchMcpTool(
      'obsidian_rag_index',
      { vault_path: vaultPath, workspace_path: outOfBoundsWorkspace },
      context,
    )).rejects.toThrow(/workspace_path is outside the allowed vault boundary/);
  });

  it('accepts allowed vault and workspace overrides inside OBSIDIAN_ALLOWED_VAULTS', async () => {
    const allowedRoot = await makeTempDir('allowed-vaults-');
    const vaultPath = path.join(allowedRoot, 'vault');
    const altVaultPath = path.join(allowedRoot, 'alt-vault');
    const workspacePath = path.join(allowedRoot, 'workspace', 'indexes');
    await fs.mkdir(vaultPath);
    await fs.mkdir(altVaultPath);
    process.env.OBSIDIAN_ALLOWED_VAULTS = allowedRoot;
    const { context, indexer } = await createFakeContext({ vault_path: vaultPath });

    await dispatchMcpTool(
      'obsidian_rag_index',
      {
        vault_path: altVaultPath,
        workspace_path: workspacePath,
        force_reindex: true,
      },
      context,
    );

    expect(indexer.indexVault).toHaveBeenCalledWith(altVaultPath, true, workspacePath, null);
  });

  it('resolves symlinks before enforcing boundaries', async () => {
    const allowedRoot = await makeTempDir('allowed-vaults-');
    const vaultPath = path.join(allowedRoot, 'vault');
    await fs.mkdir(vaultPath);
    const symlinkToVault = path.join(await makeTempDir('symlink-parent-'), 'vault-link');
    await fs.symlink(vaultPath, symlinkToVault, 'dir');
    const { context, indexer } = await createFakeContext({ vault_path: vaultPath });

    await dispatchMcpTool(
      'obsidian_rag_query',
      { query: 'needle', vault_path: symlinkToVault },
      context,
    );

    expect(indexer.search).toHaveBeenCalledWith('needle', symlinkToVault, 5, null, null);

    const outOfBoundsVault = await makeTempDir('outside-vault-');
    const symlinkInsideBoundary = path.join(allowedRoot, 'outside-link');
    await fs.symlink(outOfBoundsVault, symlinkInsideBoundary, 'dir');
    process.env.OBSIDIAN_ALLOWED_VAULTS = allowedRoot;
    const allowlistContext = (await createFakeContext({ vault_path: vaultPath })).context;

    await expect(dispatchMcpTool(
      'obsidian_rag_query',
      { query: 'needle', vault_path: symlinkInsideBoundary },
      allowlistContext,
    )).rejects.toThrow(/vault_path is outside the allowed vault boundary/);
  });

  it('bootstraps obsidian_set_vault when no vault is configured, then keeps overrides in that vault', async () => {
    const vaultPath = await makeTempDir('bootstrap-vault-');
    const otherVaultPath = await makeTempDir('other-vault-');
    const { context, indexer } = await createFakeContext({ vault_path: null });

    await dispatchMcpTool('obsidian_set_vault', { path: vaultPath }, context);
    await dispatchMcpTool('obsidian_rag_query', { query: 'needle' }, context);

    expect(indexer.reset).toHaveBeenCalledOnce();
    expect(indexer.search).toHaveBeenCalledWith('needle', vaultPath, 5, null, null);
    await expect(dispatchMcpTool(
      'obsidian_rag_query',
      { query: 'needle', vault_path: otherVaultPath },
      context,
    )).rejects.toThrow(/vault_path is outside the allowed vault boundary/);
  });

  it('requires overwrite=true before obsidian_move_note replaces an existing destination', async () => {
    const { context, indexer, vaultPath } = await createFakeContext();
    await fs.writeFile(path.join(vaultPath, 'source.md'), 'source', 'utf-8');
    await fs.writeFile(path.join(vaultPath, 'dest.md'), 'dest', 'utf-8');

    await expect(dispatchMcpTool(
      'obsidian_move_note',
      { source_path: 'source.md', dest_path: 'dest.md' },
      context,
    )).rejects.toThrow(/Destination note already exists/);
    await expect(fs.readFile(path.join(vaultPath, 'dest.md'), 'utf-8')).resolves.toBe('dest');

    await dispatchMcpTool(
      'obsidian_move_note',
      { source_path: 'source.md', dest_path: 'dest.md', overwrite: true },
      context,
    );

    await expect(fs.readFile(path.join(vaultPath, 'dest.md'), 'utf-8')).resolves.toBe('source');
    expect(indexer.moveFile).toHaveBeenCalledWith(vaultPath, 'source.md', 'dest.md', null, null);
  });
});
