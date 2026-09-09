import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as lancedb from '@lancedb/lancedb';
import { VaultIndexer, STORAGE_DIR_NAME } from '../src/rag/store';
import { Embedder } from '../src/rag/embedder';
import { createToolContext } from '../src/index';
import { dispatchMcpTool } from '../src/tools/dispatch';

vi.mock('../src/rag/embedder', () => ({
  Embedder: { getInstance: vi.fn(() => ({
    embed: async () => new Array(384).fill(0.1),
    embedBatch: async (texts: string[]) => texts.map(() => new Array(384).fill(0.1)),
  })) },
}));

describe('indexing policy', () => {
  let tmp: string;
  let vault: string;
  let store: string;
  let indexer: VaultIndexer;
  const text = 'Pineapplemarker is sufficiently long knowledge content that would otherwise produce one searchable chunk.';

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'indexing-policy-'));
    vault = path.join(tmp, 'vault');
    store = path.join(tmp, STORAGE_DIR_NAME, 'vaults', 'policy');
    await fs.mkdir(vault);
    indexer = new VaultIndexer();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await indexer.reset();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function write(relative: string, content = text) {
    await fs.mkdir(path.dirname(path.join(vault, relative)), { recursive: true });
    await fs.writeFile(path.join(vault, relative), content);
  }

  async function rows() {
    const db = await lancedb.connect(path.join(store, 'lancedb'));
    try {
      const table = await db.openTable('notes');
      try { return await table.query().toArray(); } finally { table.close(); }
    } finally { db.close(); }
  }

  it.each(['view.base', 'config.yaml', 'readme.txt', 'UPPER.MD', '.hidden.md', '.obsidian/note.md'])(
    'skips %s on direct writes without creating a database or loading embeddings', async relative => {
      await write(relative);
      expect(await indexer.indexFile(vault, relative, tmp, 'policy')).toMatchObject({ success: true, chunks: 0 });
      expect(Embedder.getInstance).not.toHaveBeenCalled();
      await expect(fs.stat(path.join(store, 'lancedb'))).rejects.toThrow();
      await expect(fs.stat(path.join(store, 'file-hashes.json'))).rejects.toThrow();
    });

  it('keeps scanner and direct-write membership equal', async () => {
    for (const relative of ['note.md', 'folder/note.md', 'view.base', '.hidden.md', 'UPPER.MD', '.config/note.md']) {
      await write(relative);
      await indexer.indexFile(vault, relative, tmp, 'policy');
    }
    const direct = (await rows()).map(row => row.path).sort();
    await indexer.indexVault(vault, true, tmp, 'policy');
    expect(direct).toEqual((await rows()).map(row => row.path).sort());
    expect(direct).toEqual(['folder/note.md', 'note.md']);
  });

  it('creates a non-markdown file through MCP without indexing its content', async () => {
    const context = createToolContext(indexer, { vault_path: vault, workspace_path: tmp, vault_id: 'policy' }, {
      saveConfig: async () => {},
    });
    const response = await dispatchMcpTool('obsidian_create_note', { file_path: 'view.base', content: text }, context);
    expect(response.isError).not.toBe(true);
    expect(await fs.readFile(path.join(vault, 'view.base'), 'utf8')).toBe(text);
    expect(Embedder.getInstance).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(store, 'lancedb'))).rejects.toThrow();
  });

  it('cleans legacy excluded rows and hashes without masking an external markdown edit', async () => {
    await write('note.md');
    await indexer.indexVault(vault, true, tmp, 'policy');
    const db = await lancedb.connect(path.join(store, 'lancedb'));
    const table = await db.openTable('notes');
    await table.update({ where: "path = 'note.md'", values: { path: 'view.base' } });
    table.close(); db.close();
    await fs.writeFile(path.join(store, 'file-hashes.json'), JSON.stringify({ 'view.base': 'legacy' }));
    const before = await fs.readFile(path.join(store, 'index-metadata.json'), 'utf8');
    await write('note.md', text + ' External edit.');
    const future = new Date(Date.now() + 10000);
    await fs.utimes(path.join(vault, 'note.md'), future, future);
    await write('view.base');
    vi.clearAllMocks();
    expect(await indexer.indexFile(vault, 'view.base', tmp, 'policy')).toMatchObject({ success: true, chunks: 0 });
    expect(await rows()).toHaveLength(0);
    expect(JSON.parse(await fs.readFile(path.join(store, 'file-hashes.json'), 'utf8'))).toEqual({});
    expect(await fs.readFile(path.join(store, 'index-metadata.json'), 'utf8')).toBe(before);
    expect(Embedder.getInstance).not.toHaveBeenCalled();
    expect((await indexer.checkIndexStaleness(vault, tmp, 'policy')).stale).toBe(true);
  });

  it.each([
    ['old.md', 'new.base', []],
    ['old.base', 'new.md', ['new.md']],
    ['old.base', 'new.base', []],
  ])('reconciles move %s to %s, including legacy destination rows', async (source, dest, expected) => {
    // Seed old-version pollution for both paths using the real database.
    await write('seed.md');
    await indexer.indexVault(vault, true, tmp, 'policy');
    const db = await lancedb.connect(path.join(store, 'lancedb'));
    const table = await db.openTable('notes');
    const [row] = await table.query().toArray();
    await table.delete('true');
    await table.add([source, dest].map((p, i) => ({ ...row, vector: Array.from(row.vector), entities: [], communities: [], id: String(i), path: p })));
    table.close(); db.close();
    await fs.writeFile(path.join(store, 'file-hashes.json'), JSON.stringify({ [source]: 'legacy', [dest]: 'legacy' }));
    await fs.unlink(path.join(vault, 'seed.md'));
    await write(dest);
    expect((await indexer.moveFile(vault, source, dest, tmp, 'policy')).success).toBe(true);
    expect((await rows()).map(r => r.path)).toEqual(expected);
    expect(Object.keys(JSON.parse(await fs.readFile(path.join(store, 'file-hashes.json'), 'utf8')))).toEqual(expected);
  });

  it('keeps FTS, vector, and hybrid search fresh across a batch without per-note maintenance', async () => {
    await write('note.md', 'Obsoleteuniquemarker records old information that must disappear after replacing the contents of this note.');
    await indexer.indexVault(vault, true, tmp, 'policy');
    const db = await lancedb.connect(path.join(store, 'lancedb'));
    const table = await db.openTable('notes');
    const optimize = vi.spyOn(Object.getPrototypeOf(table), 'optimize');
    try {
      for (let i = 0; i < 20; i++) {
        await write('note.md', `Freshuniquemarker edit ${i} holds the current knowledge for this note and must be searchable immediately.`);
        expect((await indexer.indexFile(vault, 'note.md', tmp, 'policy')).success).toBe(true);
      }
      expect(optimize).not.toHaveBeenCalled();
      await fs.rename(path.join(vault, 'note.md'), path.join(vault, 'moved.md'));
      expect((await indexer.moveFile(vault, 'note.md', 'moved.md', tmp, 'policy')).success).toBe(true);
      expect(optimize).not.toHaveBeenCalled();
      const latest = await db.openTable('notes');
      try {
        expect((await latest.search('Freshuniquemarker', 'fts').toArray()).map(r => r.path)).toEqual(['moved.md']);
        expect(await latest.search('Obsoleteuniquemarker', 'fts').toArray()).toHaveLength(0);
        expect((await latest.vectorSearch(new Array(384).fill(0.1)).toArray()).map(r => r.path)).toEqual(['moved.md']);
        const errors = vi.spyOn(console, 'error');
        expect((await indexer.search('Freshuniquemarker', vault, 5, tmp, 'policy')).map(r => r.path)).toEqual(['moved.md']);
        expect(errors.mock.calls.some(args => String(args[0]).includes('falling back to vector'))).toBe(false);
      } finally { latest.close(); }
      expect((await indexer.indexVault(vault, false, tmp, 'policy')).chunks).toBe(0);
      expect(optimize).not.toHaveBeenCalled();
      expect(await indexer.indexVault(vault, false, tmp, 'policy', true)).toMatchObject({ success: true, chunks: 0, maintenancePerformed: true });
      expect(optimize).toHaveBeenCalledTimes(1);
      const options = optimize.mock.calls[0][0];
      expect(options.deleteUnverified).toBe(false);
      expect(Date.now() - options.cleanupOlderThan.getTime()).toBeGreaterThanOrEqual(7 * 86400000);
      await fs.unlink(path.join(vault, 'moved.md'));
      expect((await indexer.indexVault(vault, false, tmp, 'policy')).success).toBe(true);
      expect(optimize).toHaveBeenCalledTimes(2);
      expect(await rows()).toHaveLength(0);
      await indexer.indexVault(vault, false, tmp, 'policy');
      expect(optimize).toHaveBeenCalledTimes(2);
    } finally { table.close(); db.close(); }
  });

  it('runs explicit maintenance on an empty index and skips unchanged automatic scans', async () => {
    expect(await indexer.indexVault(vault, false, tmp, 'policy', true)).toMatchObject({ success: true, maintenancePerformed: true });
    const db = await lancedb.connect(path.join(store, 'lancedb'));
    const table = await db.openTable('notes');
    const optimize = vi.spyOn(Object.getPrototypeOf(table), 'optimize');
    try {
      await indexer.indexVault(vault, false, tmp, 'policy');
      expect(optimize).not.toHaveBeenCalled();
      await indexer.indexVault(vault, false, tmp, 'policy', true);
      expect(optimize).toHaveBeenCalledTimes(1);
    } finally { table.close(); db.close(); }
  });

  it('reports maintenance failure and releases the lock for a retry', async () => {
    await write('note.md');
    await indexer.indexVault(vault, true, tmp, 'policy');
    const db = await lancedb.connect(path.join(store, 'lancedb'));
    const table = await db.openTable('notes');
    const optimize = vi.spyOn(Object.getPrototypeOf(table), 'optimize').mockRejectedValueOnce(new Error('maintenance failed'));
    try {
      await expect(indexer.indexVault(vault, false, tmp, 'policy', true)).rejects.toThrow('maintenance failed');
      await expect(fs.stat(path.join(store, 'index.lock'))).rejects.toThrow();
      expect((await indexer.indexVault(vault, false, tmp, 'policy', true)).success).toBe(true);
      expect(optimize).toHaveBeenCalledTimes(2);
    } finally { table.close(); db.close(); }
  });

  it('waits for the existing vault lock before explicit maintenance', async () => {
    await write('note.md');
    await indexer.indexVault(vault, true, tmp, 'policy');
    const lock = JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: 'other-writer' });
    await fs.writeFile(path.join(store, 'index.lock'), lock);
    vi.stubEnv('OBSIDIAN_INDEX_LOCK_WAIT_MS', '20');
    vi.stubEnv('OBSIDIAN_INDEX_LOCK_RETRY_MS', '5');
    await expect(indexer.indexVault(vault, false, tmp, 'policy', true)).rejects.toThrow('Timed out waiting');
    expect(await fs.readFile(path.join(store, 'index.lock'), 'utf8')).toBe(lock);
  });

  it('makes the first note searchable through FTS without a preceding vault scan', async () => {
    await write('note.md');
    expect((await indexer.indexFile(vault, 'note.md', tmp, 'policy')).success).toBe(true);
    const db = await lancedb.connect(path.join(store, 'lancedb'));
    const table = await db.openTable('notes');
    try {
      expect((await table.search('Pineapplemarker', 'fts').toArray()).map(row => row.path)).toEqual(['note.md']);
    } finally { table.close(); db.close(); }
  });
});
