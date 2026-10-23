#!/usr/bin/env node
// Copies the package.json version into the host manifests and the npm major
// into the npx launch commands. `npm version` runs this before it commits.
import { readFile, writeFile } from 'node:fs/promises';
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

const packageJson = await readJson('package.json');
const majorVersion = String(packageJson.version).split('.')[0];
const packageSpec = `${packageJson.name}@${majorVersion}`;

for (const manifestPath of ['gemini-extension.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
  const manifest = await readJson(manifestPath);
  manifest.version = packageJson.version;
  if (manifestPath !== 'gemini-extension.json') {
    manifest.license = packageJson.license;
  }
  await writeJson(manifestPath, manifest);
}

for (const manifestPath of ['gemini-extension.json', '.mcp.json']) {
  const manifest = await readJson(manifestPath);
  manifest.mcpServers[mcpServerName].args = ['-y', packageSpec];
  await writeJson(manifestPath, manifest);
}

const escapedPackageName = packageJson.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const packagePinPattern = new RegExp(`${escapedPackageName}@\\d+`, 'g');
const sessionInitPath = path.join(repoRoot, 'scripts/session-init.sh');
const sessionInit = await readFile(sessionInitPath, 'utf-8');
await writeFile(sessionInitPath, sessionInit.replace(packagePinPattern, packageSpec), 'utf-8');

process.stdout.write(`synced project version ${packageJson.version} (npm major ${majorVersion})\n`);
