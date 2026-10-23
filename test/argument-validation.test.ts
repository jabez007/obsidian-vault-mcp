import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createToolContext } from '../src/index';
import { dispatchCliTool, dispatchMcpTool } from '../src/tools/dispatch';
import { obsidianTools } from '../src/tools/registry';
import type { ObsidianTool, ToolArguments, VaultIndexerLike } from '../src/tools/types';

const requiredCases = obsidianTools.flatMap(tool => (tool.inputSchema.required ?? []).flatMap(key =>
  ['CLI', 'MCP'].map(channel => ({ tool, key, channel }))));

async function files(root: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result[entry.name] = await files(target);
    else {
      const stat = await fs.stat(target);
      result[entry.name] = { bytes: (await fs.readFile(target)).toString('hex'), mtimeMs: stat.mtimeMs, ino: stat.ino };
    }
  }
  return result;
}

describe('tool argument validation', () => {
  let tmp: string;
  let vault: string;
  let workspace: string;
  let indexer: VaultIndexerLike;
  let context: ReturnType<typeof createToolContext>;
  let before: Record<string, unknown>;

  function validArguments(tool: ObsidianTool): ToolArguments {
    const values: ToolArguments = {
      path: vault, vault_path: vault, workspace_path: workspace, vault_id: 'test',
      file_path: 'existing.md', source_path: 'source.md', dest_path: 'dest.md',
      content: 'Replacement', heading: 'Heading', old_text: 'Original', new_text: '',
      query: 'Original', file_name: 'existing', key: 'status', value: 'done',
      updates: { status: 'done' }, position: 'end', overwrite: true,
    };
    return Object.fromEntries(Object.keys(tool.inputSchema.properties ?? {})
      .filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]]));
  }

  function cliArguments(args: ToolArguments): string[] {
    return Object.entries(args).flatMap(([key, value]) => [`--${key}`, typeof value === 'string' ? value : JSON.stringify(value)]);
  }

  async function unchanged() {
    expect(await files(tmp)).toEqual(before);
    for (const method of ['getVaultPath', 'getWorkspacePath', 'getVaultId', 'setConfig'] as const) {
      expect(context[method]).not.toHaveBeenCalled();
    }
    for (const method of Object.values(indexer)) expect(method).not.toHaveBeenCalled();
  }

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-validation-'));
    vault = path.join(tmp, 'vault'); workspace = path.join(tmp, 'workspace');
    await fs.mkdir(vault); await fs.mkdir(workspace);
    for (const file of ['existing.md', 'source.md', 'dest.md', 'undefined']) {
      await fs.writeFile(path.join(vault, file), '# Heading\n\nOriginal content.\n');
    }
    await fs.writeFile(path.join(workspace, 'index-metadata.json'), '{ "sentinel": true }\n');
    await fs.writeFile(path.join(workspace, 'file-hashes.json'), '{ "existing.md": "original" }\n');
    indexer = {
      reset: vi.fn(async () => {}),
      prepareIndexSnapshot: vi.fn(async () => ({ success: true })),
      indexFile: vi.fn(async () => ({ success: true })),
      indexVault: vi.fn(async () => ({ success: true })),
      moveFile: vi.fn(async () => ({ success: true })),
      checkIndexStaleness: vi.fn(async () => ({ stale: false })),
      search: vi.fn(async () => []),
    };
    context = createToolContext(indexer, { vault_path: vault, workspace_path: workspace, vault_id: 'test' }, { saveConfig: vi.fn(async () => {}) });
    for (const method of ['getVaultPath', 'getWorkspacePath', 'getVaultId', 'setConfig'] as const) vi.spyOn(context, method);
    before = await files(tmp);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it.each(requiredCases)('$channel rejects $tool.name without $key before any side effects', async ({ tool, key, channel }) => {
    const args = validArguments(tool); delete args[key];
    if (channel === 'CLI') {
      const result = await dispatchCliTool([tool.name, ...cliArguments(args)], context, async () => '');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(`${tool.name}: ${key} is required`);
    } else {
      const result = await dispatchMcpTool(tool.name, args, context).catch(error => ({ isError: true, content: [{ text: String(error) }] }));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(`${tool.name}: ${key} is required`);
    }
    await unchanged();
  });

  it.each([
    { name: 'obsidian_read_note', args: { file_path: '' }, field: 'file_path' },
    { name: 'obsidian_read_note', args: { file_path: '  ' }, field: 'file_path' },
    { name: 'obsidian_read_note', args: { file_path: 7 }, field: 'file_path' },
    { name: 'obsidian_read_note', args: { file_path: null }, field: 'file_path' },
    { name: 'obsidian_read_note', args: { file_path: [] }, field: 'file_path' },
    { name: 'obsidian_create_note', args: { file_path: 'existing.md', content: 0, overwrite: true }, field: 'content' },
    { name: 'obsidian_create_note', args: { file_path: 'existing.md', content: '', overwrite: 'false' }, field: 'overwrite' },
    { name: 'obsidian_rag_query', args: { query: '' }, field: 'query' },
    { name: 'obsidian_rag_query', args: { query: 'test', limit: '5' }, field: 'limit' },
    { name: 'obsidian_rag_query', args: { query: 'test', limit: NaN }, field: 'limit' },
    { name: 'obsidian_rag_query', args: { query: 'test', entities: [false] }, field: 'entities' },
    { name: 'obsidian_update_frontmatter', args: { file_path: 'existing.md', updates: [] }, field: 'updates' },
    { name: 'obsidian_update_frontmatter', args: { file_path: 'existing.md', key: 'status' }, field: 'value' },
    { name: 'obsidian_update_frontmatter', args: { file_path: 'existing.md', value: 'done' }, field: 'key' },
    { name: 'obsidian_update_frontmatter', args: { file_path: 'existing.md' }, field: 'updates' },
    { name: 'obsidian_insert_at_heading', args: { file_path: 'existing.md', heading: 'Heading', content: '', position: 'middle' }, field: 'position' },
  ])('MCP rejects invalid $name.$field without side effects', async ({ name, args, field }) => {
    const result = await dispatchMcpTool(name, args, context).catch(error => ({ isError: true, content: [{ text: String(error) }] }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(name);
    expect(result.content[0].text).toContain(field);
    await unchanged();
  });

  it.each(['--typo', '--help=unexpected', '--force', '--hook'])('CLI rejects unsupported create option %s without side effects', async option => {
    const result = await dispatchCliTool(['obsidian_create_note', '--file_path', 'existing.md', '--content', 'replacement', '--overwrite', option], context, async () => '');
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Unknown option');
    await unchanged();
  });

  it('prints tool help without invoking a handler', async () => {
    const result = await dispatchCliTool(['obsidian_create_note', '--help'], context, async () => '');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('obsidian_create_note');
    expect(result.output).toContain('--file_path');
    expect(result.output).toContain('--content');
    await unchanged();
  });

  it('keeps empty note content and empty replacement text valid', async () => {
    const created = await dispatchMcpTool('obsidian_create_note', { file_path: 'empty.md', content: '' }, context);
    expect(created.isError).not.toBe(true);
    expect(await fs.readFile(path.join(vault, 'empty.md'), 'utf8')).toBe('');
    const replaced = await dispatchMcpTool('obsidian_replace_in_note', { file_path: 'existing.md', old_text: 'Original', new_text: '' }, context);
    expect(replaced.isError).not.toBe(true);
    expect(await fs.readFile(path.join(vault, 'existing.md'), 'utf8')).toBe('# Heading\n\n content.\n');
  });

  it('normalizes CLI JSON objects before shared validation', async () => {
    const result = await dispatchCliTool(['obsidian_update_frontmatter', '--file_path', 'existing.md', '--updates', '{"status":"done","priority":3}'], context, async () => '');
    expect(result.exitCode).toBe(0);
    expect(await fs.readFile(path.join(vault, 'existing.md'), 'utf8')).toContain('priority: 3');
  });

  it.each([
    { updates: { status: 'reviewed' } },
    { key: 'status', value: 'reviewed' },
  ])('accepts a complete frontmatter update mode over MCP: %j', async mode => {
    const result = await dispatchMcpTool('obsidian_update_frontmatter', { file_path: 'existing.md', ...mode }, context);
    expect(result.isError).not.toBe(true);
    expect(await fs.readFile(path.join(vault, 'existing.md'), 'utf8')).toContain('status: reviewed');
  });

  it.each([null, [], false, 'text', 42])('rejects a non-object MCP argument container: %j', async args => {
    const result = await dispatchMcpTool('obsidian_get_config', args as any, context);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('arguments must be an object');
    await unchanged();
  });

  it.each([
    { name: 'obsidian_create_note', args: ['--file_path=existing.md', '--content=x', '--overwrite=not-a-boolean'], field: 'overwrite' },
    { name: 'obsidian_rag_query', args: ['--query=test', '--limit=not-a-number'], field: 'limit' },
    { name: 'obsidian_update_frontmatter', args: ['--file_path=existing.md', '--updates={'], field: 'updates' },
    { name: 'obsidian_update_frontmatter', args: ['--file_path=existing.md', '--updates=null'], field: 'updates' },
  ])('rejects malformed CLI $field before side effects', async ({ name, args, field }) => {
    const result = await dispatchCliTool([name, ...args], context, async () => '');
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(`${name}:`);
    expect(result.output).toContain(field);
    await unchanged();
  });

  it('preserves set_vault aliases and nullable configuration resets', async () => {
    const cli = await dispatchCliTool(['obsidian_set_vault', '--vault_path', vault, '--id', 'alias'], context, async () => '');
    expect(cli.exitCode).toBe(0);
    expect(context.getConfig().vault_id).toBe('alias');
    const mcp = await dispatchMcpTool('obsidian_set_vault', { vault_path: vault, id: 'mcp-alias' }, context);
    expect(mcp.isError).not.toBe(true);
    const reset = await dispatchMcpTool('obsidian_set_vault', { path: vault, workspace_path: null, vault_id: null }, context);
    expect(reset.isError).not.toBe(true);
    expect(context.getConfig()).toEqual({ vault_path: vault, workspace_path: null, vault_id: null });
  });

  it('preserves the index force alias when both flags are present', async () => {
    const result = await dispatchCliTool(['obsidian_rag_index', '--force=true', '--force_reindex=false'], context, async () => '');
    expect(result.exitCode).toBe(0);
    expect(indexer.indexVault).toHaveBeenCalledWith(vault, true, workspace, 'test', false);
  });

  it('rejects missing arguments over real MCP stdio before changing files or index state', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/index.js')],
      env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        HOME: tmp, OBSIDIAN_VAULT_PATH: vault, OBSIDIAN_WORKSPACE_PATH: workspace, OBSIDIAN_VAULT_ID: 'test', OBSIDIAN_ALLOWED_VAULTS: tmp,
        HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }, stderr: 'pipe' });
    const client = new Client({ name: 'argument-validation-regression', version: '1.0.0' });
    try {
      await client.connect(transport);
      const listing = await client.listTools();
      for (const tool of listing.tools) {
        expect(tool.inputSchema.type).toBe('object');
        for (const keyword of ['anyOf', 'oneOf', 'allOf']) expect(Object.hasOwn(tool.inputSchema, keyword)).toBe(false);
        expect(Object.hasOwn(tool, 'requiredArgumentGroups')).toBe(false);
      }
      for (const { tool, key } of requiredCases.filter(test => test.channel === 'MCP')) {
        const args = validArguments(tool); delete args[key];
        // Use the raw request path so client-side tool validation cannot hide
        // a missing validation check in the server.
        const result = await client.request({ method: 'tools/call', params: { name: tool.name, arguments: args } }, CallToolResultSchema, { timeout: 3000 });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(`${tool.name}: ${key} is required`);
      }
    } finally { await client.close(); }
    await unchanged();
  });

  it('keeps real CLI help read-only and rejects malformed write calls', async () => {
    const run = promisify(execFile);
    const options = { env: { ...process.env, HOME: tmp, OBSIDIAN_VAULT_PATH: vault,
      OBSIDIAN_WORKSPACE_PATH: workspace, OBSIDIAN_VAULT_ID: 'test', OBSIDIAN_ALLOWED_VAULTS: tmp,
      HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } };
    const cli = path.resolve('dist/index.js');
    const help = await run(process.execPath, [cli, 'obsidian_create_note', '--help'], options);
    expect(help.stdout).toContain('Usage: obsidian-vault-mcp obsidian_create_note');
    for (const [name, args, message] of [
      ['obsidian_append_note', ['--content=y'], 'file_path is required'],
      ['obsidian_create_note', ['--file_path=existing.md', '--overwrite'], 'content is required'],
      ['obsidian_create_note', ['--file_path=existing.md', '--content=x', '--overwrite', '--typo'], 'Unknown option --typo'],
    ] as const) {
      await expect(run(process.execPath, [cli, name, ...args], options)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(message) });
    }
    await unchanged();
  });
});
