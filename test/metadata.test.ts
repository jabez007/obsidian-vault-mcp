import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
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
    const codexPlugin = await readJson('.codex-plugin/plugin.json');

    expect(geminiExtension.version).toBe(packageJson.version);
    expect(claudePlugin.version).toBe(packageJson.version);
    expect(codexPlugin.version).toBe(packageJson.version);
  });

  it('uses the inherited ISC license across package and plugin metadata', async () => {
    const packageJson = await readJson('package.json');
    const claudePlugin = await readJson('.claude-plugin/plugin.json');
    const codexPlugin = await readJson('.codex-plugin/plugin.json');

    expect(packageJson.license).toBe('ISC');
    expect(claudePlugin.license).toBe(packageJson.license);
    expect(codexPlugin.license).toBe(packageJson.license);
  });

  it('uses the neutral project name in host manifests', async () => {
    const packageJson = await readJson('package.json');
    const geminiExtension = await readJson('gemini-extension.json');
    const claudePlugin = await readJson('.claude-plugin/plugin.json');
    const claudeMarketplace = await readJson('.claude-plugin/marketplace.json');
    const codexPlugin = await readJson('.codex-plugin/plugin.json');
    const codexMarketplace = await readJson('.agents/plugins/marketplace.json');
    const rootMcp = await readJson('.mcp.json');

    expect(packageJson.name).toBe('@jabez007/obsidian-vault-mcp');
    expect(geminiExtension.name).toBe(MCP_SERVER_NAME);
    expect(claudePlugin.name).toBe(MCP_SERVER_NAME);
    expect(claudeMarketplace.name).toBe(MCP_SERVER_NAME);
    expect(claudeMarketplace.plugins[0].name).toBe(MCP_SERVER_NAME);
    expect(codexPlugin.name).toBe(MCP_SERVER_NAME);
    expect(codexMarketplace.plugins[0].name).toBe(MCP_SERVER_NAME);
    expect(Object.keys(claudePlugin.mcpServers)).toEqual([MCP_SERVER_NAME]);
    expect(Object.keys(rootMcp.mcpServers)).toEqual([MCP_SERVER_NAME]);
  });

  it('launches the published npm package pinned to the current major version', async () => {
    const packageJson = await readJson('package.json');
    const geminiExtension = await readJson('gemini-extension.json');
    const rootMcp = await readJson('.mcp.json');
    const sessionInit = await fs.readFile(path.join(repoRoot, 'scripts/session-init.sh'), 'utf-8');
    const majorVersion = String(packageJson.version).split('.')[0];

    expectNpxLaunch(geminiExtension, packageJson.name, majorVersion);
    expectNpxLaunch(rootMcp, packageJson.name, majorVersion);
    expect(sessionInit).toContain(`${packageJson.name}@${majorVersion}`);
  });

  it('installs every host plugin from the repository root', async () => {
    const claudeMarketplace = await readJson('.claude-plugin/marketplace.json');
    const codexMarketplace = await readJson('.agents/plugins/marketplace.json');
    const codexPlugin = await readJson('.codex-plugin/plugin.json');

    expect(claudeMarketplace.plugins[0].source).toBe('./');
    expect(codexMarketplace.plugins[0].source).toEqual({ source: 'local', path: './' });
    expect(codexPlugin.mcpServers).toBe('./.mcp.json');
  });

  it('runs the checked-in build from the Claude Code plugin', async () => {
    const claudePlugin = await readJson('.claude-plugin/plugin.json');

    // Claude Code installs package.json dependencies into its plugin copy.
    expect(claudePlugin.mcpServers[MCP_SERVER_NAME]).toEqual({
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/dist/index.js'],
    });
    // Gemini commands and agents use formats Claude Code does not read.
    expect(claudePlugin.commands).toEqual([]);
    expect(claudePlugin.agents).toEqual([]);
  });

  it('shares one session hook across plugin hosts', async () => {
    const hooks = await readJson('hooks/hooks.json');

    expect(Object.keys(hooks.hooks)).toEqual(['SessionStart']);
    const command: string = hooks.hooks.SessionStart[0].hooks[0].command;

    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-hook-root-'));
    try {
      await fs.mkdir(path.join(pluginRoot, 'scripts'));
      await fs.writeFile(path.join(pluginRoot, 'scripts', 'session-init.sh'), 'printf %s "$0"');
      const runHook = (hookCommand: string, env: NodeJS.ProcessEnv) =>
        execFileSync('bash', ['-c', hookCommand], { encoding: 'utf-8', env: { PATH: process.env.PATH, ...env } });
      const expected = path.join(pluginRoot, 'scripts', 'session-init.sh');

      // Claude Code and Codex export CLAUDE_PLUGIN_ROOT to the hook process.
      expect(runHook(command, { CLAUDE_PLUGIN_ROOT: pluginRoot })).toBe(expected);

      // Gemini CLI replaces ${name} tokens in hooks.json with this expression
      // (hydrateString in Gemini CLI 0.42) and doesn't pass CLAUDE_PLUGIN_ROOT.
      const geminiCommand = command.replace(/\${(.*?)}/g, (match, key) => (key === 'extensionPath' ? pluginRoot : match));
      expect(runHook(geminiCommand, {})).toBe(expected);
    } finally {
      await fs.rm(pluginRoot, { recursive: true, force: true });
    }
  });
});
