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
    checkIndexStaleness: vi.fn(async () => ({ stale: false })),
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
    expect(response.tools.find((tool) => tool.name === 'obsidian_rag_query')?.inputSchema.properties?.entities).toEqual({
      type: 'array',
      description: 'Optional entity labels to require in matching chunks. Matched exactly (case-sensitive); comma-separated for CLI',
      items: { type: 'string' },
    });
    expect(response.tools.find((tool) => tool.name === 'obsidian_create_note')?.inputSchema.properties?.overwrite).toEqual({
      type: 'boolean',
      description: 'Overwrite an existing note at the same path (default: false)',
    });
  });

  it('caps filename search matches at 20 results', async () => {
    const { context, vaultPath } = await createFakeContext();
    for (let i = 0; i < 25; i++) {
      await fs.writeFile(
        path.join(vaultPath, `needle-${String(i).padStart(2, '0')}.md`),
        'content that does not matter for filename matches',
        'utf-8',
      );
    }

    const result = await dispatchMcpTool('obsidian_search_notes', { query: 'needle' }, context);
    const matches = result.content[0].text.split('\n');

    expect(matches).toHaveLength(20);
    expect(matches.every((match) => match.endsWith('(Filename match)'))).toBe(true);
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

    expect(indexer.search).toHaveBeenCalledWith('needle', altVaultPath, 3, null, null, {
      entities: [],
      communities: [],
    });
    expect(result.content[0].text).toBe(
      '---\nFile: Notes/A.md\nRelevance: 0.875\nContent: matched text\n---\n' +
      '---\nFile: Notes/B.md\nRelevance: 0.125\nContent: fallback text\n---',
    );
  });

  it('passes RAG entity and community filters to the indexer', async () => {
    const { context, indexer, vaultPath } = await createFakeContext();

    await dispatchMcpTool(
      'obsidian_rag_query',
      {
        query: 'needle',
        entities: ['AI', 'Climate Change'],
        communities: 'Technology, Sustainability',
      },
      context,
    );

    expect(indexer.search).toHaveBeenCalledWith('needle', vaultPath, 5, null, null, {
      entities: ['AI', 'Climate Change'],
      communities: ['Technology', 'Sustainability'],
    });
  });

  it('rejects malformed RAG filters instead of silently searching unfiltered', async () => {
    const { context, indexer } = await createFakeContext();

    await expect(dispatchMcpTool(
      'obsidian_rag_query',
      { query: 'needle', entities: [42] },
      context,
    )).rejects.toThrow("'entities' must be an array of strings");
    expect(indexer.search).not.toHaveBeenCalled();
  });

  it('parses CLI array flags into string arrays', async () => {
    const { context, indexer, vaultPath } = await createFakeContext();
    await dispatchCliTool(
      ['obsidian_rag_query', '--query', 'needle', '--vault_path', vaultPath, '--entities', 'AI, Climate Change'],
      context,
      async () => '',
    );

    expect(indexer.search).toHaveBeenCalledWith('needle', vaultPath, 5, null, null, {
      entities: ['AI', 'Climate Change'],
      communities: [],
    });
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

  it('appends a stale index notice to RAG query results', async () => {
    const { context, indexer, vaultPath } = await createFakeContext();
    vi.mocked(indexer.checkIndexStaleness).mockResolvedValue({
      stale: true,
      reason: 'vault files changed after the last index',
    });

    const result = await dispatchMcpTool('obsidian_rag_query', { query: 'needle' }, context);

    expect(indexer.checkIndexStaleness).toHaveBeenCalledWith(vaultPath, null, null);
    expect(indexer.search).toHaveBeenCalledWith('needle', vaultPath, 5, null, null, {
      entities: [],
      communities: [],
    });
    expect(result.content[0].text).toContain('File: Notes/A.md');
    expect(result.content[0].text).toContain('Index may be stale (vault files changed after the last index). Run obsidian_rag_index to refresh.');
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

    expect(indexer.search).toHaveBeenCalledWith('needle', symlinkToVault, 5, null, null, {
      entities: [],
      communities: [],
    });

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

  it('rejects obsidian_read_note through an in-vault symlink pointing outside the vault', async () => {
    const { context, vaultPath } = await createFakeContext();
    const outsideDir = await makeTempDir('outside-note-target-');
    await fs.writeFile(
      path.join(outsideDir, 'secret.md'),
      'outside content should not be readable through the vault',
      'utf-8',
    );
    await fs.symlink(path.join(outsideDir, 'secret.md'), path.join(vaultPath, 'linked-secret.md'));

    await expect(dispatchMcpTool(
      'obsidian_read_note',
      { file_path: 'linked-secret.md' },
      context,
    )).rejects.toThrow(/Path traversal detected/);
  });

  it('rejects obsidian_create_note through an in-vault symlinked folder pointing outside the vault', async () => {
    const { context, vaultPath } = await createFakeContext();
    const outsideDir = await makeTempDir('outside-create-target-');
    await fs.symlink(outsideDir, path.join(vaultPath, 'linked-folder'), 'dir');

    await expect(dispatchMcpTool(
      'obsidian_create_note',
      { file_path: 'linked-folder/new-note.md', content: 'outside write should be blocked' },
      context,
    )).rejects.toThrow(/Path traversal detected/);
    await expect(fs.stat(path.join(outsideDir, 'new-note.md'))).rejects.toThrow();
  });

  it('rejects obsidian_create_note through a dangling in-vault symlink pointing outside the vault', async () => {
    const { context, vaultPath } = await createFakeContext();
    const outsideDir = await makeTempDir('outside-dangling-target-');
    const outsideTarget = path.join(outsideDir, 'not-yet-created.md');
    await fs.symlink(outsideTarget, path.join(vaultPath, 'dangling.md'));

    await expect(dispatchMcpTool(
      'obsidian_create_note',
      { file_path: 'dangling.md', content: 'write through dangling symlink should be blocked' },
      context,
    )).rejects.toThrow(/Path traversal detected/);
    await expect(fs.stat(outsideTarget)).rejects.toThrow();
  });

  it('allows symlinked vault folders when their real target is in OBSIDIAN_ALLOWED_VAULTS', async () => {
    const { context, vaultPath, indexer } = await createFakeContext();
    const outsideDir = await makeTempDir('allowed-symlink-target-');
    process.env.OBSIDIAN_ALLOWED_VAULTS = [vaultPath, outsideDir].join(path.delimiter);
    await fs.symlink(outsideDir, path.join(vaultPath, 'linked-folder'), 'dir');

    const result = await dispatchMcpTool(
      'obsidian_create_note',
      { file_path: 'linked-folder/new-note.md', content: 'allowed linked folder write' },
      context,
    );

    expect(result.content[0].text).toBe('Created note: linked-folder/new-note.md');
    await expect(fs.readFile(path.join(outsideDir, 'new-note.md'), 'utf-8')).resolves.toBe('allowed linked folder write');
    expect(indexer.indexFile).toHaveBeenCalledWith(vaultPath, 'linked-folder/new-note.md', null, null);
  });

  it('requires overwrite=true before obsidian_create_note replaces an existing note', async () => {
    const { context, indexer, vaultPath } = await createFakeContext();
    await fs.writeFile(path.join(vaultPath, 'existing.md'), 'original content', 'utf-8');

    await expect(dispatchMcpTool(
      'obsidian_create_note',
      { file_path: 'existing.md', content: 'replacement content' },
      context,
    )).rejects.toThrow(/Note already exists/);
    await expect(fs.readFile(path.join(vaultPath, 'existing.md'), 'utf-8')).resolves.toBe('original content');
    expect(indexer.indexFile).not.toHaveBeenCalled();

    await dispatchMcpTool(
      'obsidian_create_note',
      { file_path: 'existing.md', content: 'replacement content', overwrite: true },
      context,
    );

    await expect(fs.readFile(path.join(vaultPath, 'existing.md'), 'utf-8')).resolves.toBe('replacement content');
    expect(indexer.indexFile).toHaveBeenCalledWith(vaultPath, 'existing.md', null, null);
  });

  it('bootstraps obsidian_set_vault when no vault is configured, then keeps overrides in that vault', async () => {
    const vaultPath = await makeTempDir('bootstrap-vault-');
    const otherVaultPath = await makeTempDir('other-vault-');
    const { context, indexer } = await createFakeContext({ vault_path: null });

    await dispatchMcpTool('obsidian_set_vault', { path: vaultPath }, context);
    await dispatchMcpTool('obsidian_rag_query', { query: 'needle' }, context);

    expect(indexer.reset).toHaveBeenCalledOnce();
    expect(indexer.search).toHaveBeenCalledWith('needle', vaultPath, 5, null, null, {
      entities: [],
      communities: [],
    });
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
