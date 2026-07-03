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
    const rootPlugin = await readJson('.codex-plugin/plugin.json');
    const bundledPlugin = await readJson('plugins/obsidian-vault-mcp/.codex-plugin/plugin.json');

    expect(geminiExtension.version).toBe(packageJson.version);
    expect(rootPlugin.version).toBe(packageJson.version);
    expect(bundledPlugin.version).toBe(packageJson.version);
  });

  it('uses the neutral project name in host manifests', async () => {
    const packageJson = await readJson('package.json');
    const geminiExtension = await readJson('gemini-extension.json');
    const rootMcp = await readJson('.mcp.json');
    const bundledMcp = await readJson('plugins/obsidian-vault-mcp/.mcp.json');

    expect(packageJson.name).toBe('@jabez007/obsidian-vault-mcp');
    expect(geminiExtension.name).toBe(MCP_SERVER_NAME);
    expect(Object.keys(rootMcp.mcpServers)).toEqual([MCP_SERVER_NAME]);
    expect(Object.keys(bundledMcp.mcpServers)).toEqual([MCP_SERVER_NAME]);
  });

  it('launches the published npm package pinned to the current major version', async () => {
    const packageJson = await readJson('package.json');
    const geminiExtension = await readJson('gemini-extension.json');
    const rootMcp = await readJson('.mcp.json');
    const bundledMcp = await readJson('plugins/obsidian-vault-mcp/.mcp.json');
    const majorVersion = String(packageJson.version).split('.')[0];

    expectNpxLaunch(geminiExtension, packageJson.name, majorVersion);
    expectNpxLaunch(rootMcp, packageJson.name, majorVersion);
    expectNpxLaunch(bundledMcp, packageJson.name, majorVersion);
  });
});
