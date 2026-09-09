#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const lancedb = require('@lancedb/lancedb');
const { values } = parseArgs({ options: {
  source: { type: 'string' }, label: { type: 'string', default: 'working-tree' },
  notes: { type: 'string', default: '200' }, edits: { type: 'string', default: '60' },
  'real-embeddings': { type: 'boolean', default: false },
} });
const notes = Number(values.notes), edits = Number(values.edits);
if (![notes, edits].every(n => Number.isInteger(n) && n > 0)) throw new Error('notes and edits must be positive integers');
const useRealEmbeddings = values['real-embeddings'];
const source = await fs.readFile(values.source || path.join(root, 'src/rag/store.ts'), 'utf8');
const bundle = await build({
  stdin: { contents: source, loader: 'ts', resolveDir: path.join(root, 'src/rag') },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
  plugins: useRealEmbeddings ? [] : [{ name: 'deterministic-embeddings', setup(builder) {
    builder.onResolve({ filter: /^\.\/embedder\.js$/ }, () => ({ path: 'embedder', namespace: 'benchmark' }));
    builder.onLoad({ filter: /.*/, namespace: 'benchmark' }, () => ({ contents: `
      import {createHash} from 'node:crypto';
      function vector(text) {
        const bytes = createHash('sha256').update(text).digest();
        const raw = Array.from({length: 384}, (_, i) => bytes[i % bytes.length] / 127.5 - 1);
        const norm = Math.hypot(...raw);
        return raw.map(v => v / norm);
      }
      export const Embedder = {getInstance: () => ({
        embed: async text => vector(text), embedBatch: async texts => texts.map(vector),
      })};`, loader: 'js' }));
  } }],
});
const compiled = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, compiled, compiled.exports);
const { VaultIndexer, STORAGE_DIR_NAME } = compiled.exports;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'index-maintenance-benchmark-'));
const vault = path.join(tmp, 'vault');
const dbPath = path.join(tmp, STORAGE_DIR_NAME, 'vaults', 'benchmark', 'lancedb');
const indexer = new VaultIndexer();
let optimizeCalls = 0;
let originalOptimize, prototype, db;

function content(i, revision) {
  return `---\nentities: [gardening]\n---\n# Garden observations ${i}\n\nPineapplemarker revision ${revision} records plot ${i}. `
    + 'Tomatoes need stakes and regular watering. Check soil moisture before adding water. Rotate crops between beds each season. '.repeat(7);
}
function stats(samples) {
  const sorted = samples.slice().sort((a, b) => a - b);
  const at = p => Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)].toFixed(3));
  return { count: sorted.length, medianMs: at(0.5), p95Ms: at(0.95) };
}
async function snapshot() {
  let retainedBytes = 0, dataFiles = 0;
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else {
        retainedBytes += (await fs.stat(full)).size;
        if (path.relative(dbPath, full).split(path.sep).includes('data')) dataFiles++;
      }
    }
  }
  await visit(dbPath);
  const table = await db.openTable('notes');
  try { return { retainedBytes, dataFiles, tableVersions: (await table.listVersions()).length, rows: await table.countRows(), optimizeCalls }; }
  finally { table.close(); }
}
async function queries() {
  const times = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    if (!(await indexer.search('Pineapplemarker gardening', vault, 5, tmp, 'benchmark')).length) throw new Error('Search returned no rows');
    times.push(performance.now() - start);
  }
  return stats(times);
}
try {
  await fs.mkdir(vault);
  const paths = Array.from({ length: notes }, (_, i) => `note-${i}.md`);
  await Promise.all(paths.map((p, i) => fs.writeFile(path.join(vault, p), content(i, 0))));
  const start = performance.now();
  const initial = await indexer.indexVault(vault, true, tmp, 'benchmark');
  if (!initial.success) throw new Error(initial.message);
  const initialIndexMs = performance.now() - start;
  db = await lancedb.connect(dbPath);
  const table = await db.openTable('notes');
  prototype = Object.getPrototypeOf(table);
  originalOptimize = prototype.optimize;
  prototype.optimize = async function (...args) { optimizeCalls++; return originalOptimize.apply(this, args); };
  table.close();
  const before = await snapshot();
  const beforeQuery = await queries();
  const writeTimes = [], moveTimes = [];
  for (let i = 0; i < edits; i++) {
    const n = i % notes;
    const writeStart = performance.now();
    await fs.writeFile(path.join(vault, paths[n]), content(n, i + 1));
    const result = await indexer.indexFile(vault, paths[n], tmp, 'benchmark');
    if (!result.success) throw new Error(result.message);
    writeTimes.push(performance.now() - writeStart);
    if (i % 10 === 0) {
      const moveStart = performance.now();
      const dest = `moved-${i}.md`;
      await fs.rename(path.join(vault, paths[n]), path.join(vault, dest));
      const moved = await indexer.moveFile(vault, paths[n], dest, tmp, 'benchmark');
      if (!moved.success) throw new Error(moved.message);
      paths[n] = dest;
      moveTimes.push(performance.now() - moveStart);
    }
  }
  const afterEdits = await snapshot();
  const afterEditsQuery = await queries();
  const maintenanceStart = performance.now();
  if (values.source) {
    // The baseline has no explicit maintenance flag. Run the equivalent
    // standalone operation after the completed batch in this isolated vault.
    const table = await db.openTable('notes');
    try { await table.optimize(); } finally { table.close(); }
  } else {
    const result = await indexer.indexVault(vault, false, tmp, 'benchmark', true);
    if (!result.success || !result.maintenancePerformed) throw new Error('Explicit maintenance failed');
  }
  const maintenanceMs = performance.now() - maintenanceStart;
  const afterMaintenance = await snapshot();
  const afterMaintenanceQuery = await queries();
  process.stdout.write(JSON.stringify({
    label: values.label, embeddings: useRealEmbeddings ? 'Xenova/all-MiniLM-L6-v2' : 'deterministic SHA-256 vectors',
    notes, edits, moves: moveTimes.length, initialIndexMs, before, afterEdits, afterMaintenance,
    writes: stats(writeTimes), movesLatency: stats(moveTimes), maintenanceMs,
    query: { before: beforeQuery, afterEdits: afterEditsQuery, afterMaintenance: afterMaintenanceQuery },
  }, null, 2) + '\n');
} finally {
  if (prototype) prototype.optimize = originalOptimize;
  if (db) db.close();
  await indexer.reset();
  await fs.rm(tmp, { recursive: true, force: true });
}
