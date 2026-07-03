import { describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');

async function readJson(relativePath: string) {
  return JSON.parse(await fs.readFile(path.join(repoRoot, relativePath), 'utf-8'));
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

    expect(packageJson.name).toBe('obsidian-vault-mcp');
    expect(geminiExtension.name).toBe(packageJson.name);
    expect(Object.keys(rootMcp.mcpServers)).toEqual([packageJson.name]);
    expect(Object.keys(bundledMcp.mcpServers)).toEqual([packageJson.name]);
  });
});
