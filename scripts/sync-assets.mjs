#!/usr/bin/env node
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

for (const asset of generatedAssets) {
  await syncAsset(asset);
}
