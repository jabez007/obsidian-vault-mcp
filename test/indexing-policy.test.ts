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

  it.each(['view.base', 'config.yaml', 'readme.txt', 'UPPER.MD', '.hidden.md', '.obsidian/note.md'])
    ('skips %s on direct writes without creating a database or loading embeddings', async relative => {
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
});
