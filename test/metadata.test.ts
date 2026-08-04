import { describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const MCP_SERVER_NAME = 'obsidian-vault-mcp';

async function readJson(relativePath: string) {
  return JSON.parse(await fs.readFile(path.join(repoRoot, relativePath), 'utf-8'));
}

function expectNpxLaunch(manifest: any, packageName: string, majorVersion: string) {
  const server = manifest.mcpServers[MCP_SERVER_NAME];
  expect(server.command).toBe('npx');
  expect(server.args).toEqual(['-y', `${packageName}@${majorVersion}`]);
}

describe('project metadata', () => {
  it('uses package.json as the version source of truth for manifests', async () => {
    const packageJson = await readJson('package.json');
    const geminiExtension = await readJson('gemini-extension.json');
    const claudePlugin = await readJson('.claude-plugin/plugin.json');
    const claudeMarketplace = await readJson('.claude-plugin/marketplace.json');
    const rootPlugin = await readJson('.codex-plugin/plugin.json');
    const bundledPlugin = await readJson('plugins/obsidian-vault-mcp/.codex-plugin/plugin.json');

    expect(geminiExtension.version).toBe(packageJson.version);
    expect(claudePlugin.version).toBe(packageJson.version);
    expect(claudeMarketplace.version).toBe(packageJson.version);
    expect(claudeMarketplace.plugins[0].version).toBe(packageJson.version);
    expect(rootPlugin.version).toBe(packageJson.version);
    expect(bundledPlugin.version).toBe(packageJson.version);
  });

  it('uses the neutral project name in host manifests', async () => {
    const packageJson = await readJson('package.json');
    const geminiExtension = await readJson('gemini-extension.json');
    const claudeMcp = await readJson('.claude-plugin/mcp.json');
    const claudePlugin = await readJson('.claude-plugin/plugin.json');
    const claudeMarketplace = await readJson('.claude-plugin/marketplace.json');
    const rootMcp = await readJson('.mcp.json');
    const bundledMcp = await readJson('plugins/obsidian-vault-mcp/.mcp.json');
    const openCode = await readJson('opencode.json');

    expect(packageJson.name).toBe('@jabez007/obsidian-vault-mcp');
    expect(geminiExtension.name).toBe(MCP_SERVER_NAME);
    expect(claudePlugin.name).toBe(MCP_SERVER_NAME);
    expect(claudeMarketplace.name).toBe(MCP_SERVER_NAME);
    expect(claudeMarketplace.plugins[0].name).toBe(MCP_SERVER_NAME);
    expect(Object.keys(claudeMcp.mcpServers)).toEqual([MCP_SERVER_NAME]);
    expect(Object.keys(rootMcp.mcpServers)).toEqual([MCP_SERVER_NAME]);
    expect(Object.keys(bundledMcp.mcpServers)).toEqual([MCP_SERVER_NAME]);
    expect(Object.keys(openCode.mcp)).toEqual([MCP_SERVER_NAME]);
  });

  it('launches the published npm package pinned to the current major version', async () => {
    const packageJson = await readJson('package.json');
    const geminiExtension = await readJson('gemini-extension.json');
    const rootMcp = await readJson('.mcp.json');
    const bundledMcp = await readJson('plugins/obsidian-vault-mcp/.mcp.json');
    const sessionInit = await fs.readFile(path.join(repoRoot, 'scripts/session-init.sh'), 'utf-8');
    const reindexNote = await fs.readFile(path.join(repoRoot, 'scripts/reindex-note.sh'), 'utf-8');
    const majorVersion = String(packageJson.version).split('.')[0];
    const packageSpec = `${packageJson.name}@${majorVersion}`;

    expectNpxLaunch(geminiExtension, packageJson.name, majorVersion);
    expectNpxLaunch(rootMcp, packageJson.name, majorVersion);
    expectNpxLaunch(bundledMcp, packageJson.name, majorVersion);
    expect(sessionInit).toContain(packageSpec);
    expect(reindexNote).toContain(packageSpec);
  });

  it('wires local-checkout hosts to the checked-in build output', async () => {
    const claudeMcp = await readJson('.claude-plugin/mcp.json');
    const openCode = await readJson('opencode.json');

    expect(claudeMcp.mcpServers[MCP_SERVER_NAME]).toEqual({
      command: 'bash',
      args: ['${CLAUDE_PLUGIN_ROOT}/scripts/claude-mcp-server.sh'],
    });
    expect(openCode.mcp[MCP_SERVER_NAME].command).toEqual(['node', 'dist/index.js']);
    expect(openCode.mcp[MCP_SERVER_NAME].cwd).toBe('.');
  });

  it('wires Claude Code to the shared plugin components', async () => {
    const claudePlugin = await readJson('.claude-plugin/plugin.json');
    const claudeHooks = await readJson('.claude-plugin/hooks.json');
    const claudeMarketplace = await readJson('.claude-plugin/marketplace.json');

    expect(claudePlugin.skills).toBe('./skills/');
    expect(claudePlugin.hooks).toBeUndefined();
    expect(claudePlugin.mcpServers).toBe('./.mcp.json');
    expect(claudePlugin.commands).toEqual([]);
    expect(claudePlugin.agents).toEqual([]);
    expect(Object.keys(claudeHooks.hooks)).toEqual(['SessionStart']);
    expect(claudeHooks.hooks.SessionStart[0].hooks[0].command).toBe('bash "${CLAUDE_PLUGIN_ROOT}/scripts/session-init.sh"');
    expect(claudeMarketplace.plugins[0].source).toBe('./plugins/claude-obsidian-vault-mcp');
  });
});
