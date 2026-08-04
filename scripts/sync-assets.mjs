#!/usr/bin/env node
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mcpServerName = 'obsidian-vault-mcp';

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), 'utf-8'));
}

async function writeJson(relativePath, value) {
  await writeFile(
    path.join(repoRoot, relativePath),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf-8',
  );
}

async function syncProjectVersion() {
  const packageJson = await readJson('package.json');
  const majorVersion = String(packageJson.version).split('.')[0];
  const packageSpec = `${packageJson.name}@${majorVersion}`;

  const geminiExtension = await readJson('gemini-extension.json');
  geminiExtension.version = packageJson.version;
  geminiExtension.mcpServers[mcpServerName].args = ['-y', packageSpec];
  await writeJson('gemini-extension.json', geminiExtension);

  const claudePlugin = await readJson('.claude-plugin/plugin.json');
  claudePlugin.version = packageJson.version;
  claudePlugin.license = packageJson.license;
  await writeJson('.claude-plugin/plugin.json', claudePlugin);

  const claudeMarketplace = await readJson('.claude-plugin/marketplace.json');
  claudeMarketplace.version = packageJson.version;
  for (const plugin of claudeMarketplace.plugins) {
    if (plugin.name === mcpServerName) {
      plugin.version = packageJson.version;
      plugin.license = packageJson.license;
    }
  }
  await writeJson('.claude-plugin/marketplace.json', claudeMarketplace);

  const codexPlugin = await readJson('.codex-plugin/plugin.json');
  codexPlugin.version = packageJson.version;
  codexPlugin.license = packageJson.license;
  await writeJson('.codex-plugin/plugin.json', codexPlugin);

  const rootMcp = await readJson('.mcp.json');
  rootMcp.mcpServers[mcpServerName].args = ['-y', packageSpec];
  await writeJson('.mcp.json', rootMcp);

  const escapedPackageName = packageJson.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const packagePinPattern = new RegExp(`${escapedPackageName}@\\d+`, 'g');
  for (const relativePath of [
    'scripts/reindex-note.sh',
    'scripts/session-init.sh',
  ]) {
    const filePath = path.join(repoRoot, relativePath);
    const content = await readFile(filePath, 'utf-8');
    await writeFile(filePath, content.replace(packagePinPattern, packageSpec), 'utf-8');
  }

  process.stdout.write(`synced project version ${packageJson.version} (npm major ${majorVersion})\n`);
}

const generatedAssets = [
  {
    source: '.codex-plugin',
    target: 'plugins/obsidian-vault-mcp/.codex-plugin',
    type: 'directory',
  },
  {
    source: '.mcp.json',
    target: 'plugins/obsidian-vault-mcp/.mcp.json',
    type: 'file',
  },
  {
    source: 'skills',
    target: 'plugins/obsidian-vault-mcp/skills',
    type: 'directory',
  },
  {
    source: '.claude-plugin/plugin.json',
    target: 'plugins/claude-obsidian-vault-mcp/.claude-plugin/plugin.json',
    type: 'file',
  },
  {
    source: '.claude-plugin/mcp.json',
    target: 'plugins/claude-obsidian-vault-mcp/.mcp.json',
    type: 'file',
  },
  {
    source: '.claude-plugin/hooks.json',
    target: 'plugins/claude-obsidian-vault-mcp/hooks/hooks.json',
    type: 'file',
  },
  {
    source: 'skills',
    target: 'plugins/claude-obsidian-vault-mcp/skills',
    type: 'directory',
  },
  {
    source: 'scripts/session-init.sh',
    target: 'plugins/claude-obsidian-vault-mcp/scripts/session-init.sh',
    type: 'file',
  },
  {
    source: 'scripts/claude-mcp-server.sh',
    target: 'plugins/claude-obsidian-vault-mcp/scripts/claude-mcp-server.sh',
    type: 'file',
  },
  {
    source: 'package.json',
    target: 'plugins/claude-obsidian-vault-mcp/package.json',
    type: 'file',
  },
  {
    source: 'package-lock.json',
    target: 'plugins/claude-obsidian-vault-mcp/package-lock.json',
    type: 'file',
  },
  {
    source: 'dist/index.js',
    target: 'plugins/claude-obsidian-vault-mcp/dist/index.js',
    type: 'file',
  },
];

async function ensureSource(relativePath, type) {
  const sourcePath = path.join(repoRoot, relativePath);
  let sourceStat;

  try {
    sourceStat = await stat(sourcePath);
  } catch {
    throw new Error(`Missing canonical asset source: ${relativePath}`);
  }

  if (type === 'directory' && !sourceStat.isDirectory()) {
    throw new Error(`Canonical asset source is not a directory: ${relativePath}`);
  }

  if (type === 'file' && !sourceStat.isFile()) {
    throw new Error(`Canonical asset source is not a file: ${relativePath}`);
  }
}

async function syncAsset({ source, target, type }) {
  await ensureSource(source, type);

  const sourcePath = path.join(repoRoot, source);
  const targetPath = path.join(repoRoot, target);

  await mkdir(path.dirname(targetPath), { recursive: true });
  await rm(targetPath, { recursive: true, force: true });
  await cp(sourcePath, targetPath, { recursive: type === 'directory' });

  process.stdout.write(`synced ${source} -> ${target}\n`);
}

await syncProjectVersion();

for (const asset of generatedAssets) {
  await syncAsset(asset);
}
