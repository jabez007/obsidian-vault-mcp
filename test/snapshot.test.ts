import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import * as lancedb from '@lancedb/lancedb';
import { VaultIndexer, STORAGE_DIR_NAME } from '../src/rag/store';
import { Embedder } from '../src/rag/embedder';
import { createToolContext } from '../src/index';
import { dispatchCliTool, dispatchMcpTool } from '../src/tools/dispatch';
import * as processIdentity from '../src/rag/process-identity';
import { assertLocalManifest } from '../src/rag/local-manifest';

vi.mock('../src/rag/embedder', () => ({
  Embedder: { getInstance: vi.fn(() => ({
    embed: async () => Array(384).fill(0.1),
    embedBatch: async (texts: string[]) => texts.map(() => Array(384).fill(0.1)),
  })) },
}));

async function inventory(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.name === 'snapshots' || entry.name === 'index.lock') continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [name, hash] of Object.entries(await inventory(file))) result[`${entry.name}/${name}`] = hash;
    } else result[entry.name] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  }
  return result;
}

describe('index snapshots', () => {
  let tmp: string;
  let vault: string;
  let store: string;
  let indexer: VaultIndexer;
  const note = 'Snapshotmarker preserves important gardening knowledge about tomatoes, watering, and their supporting stakes.';

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'index-snapshot-'));
    vault = path.join(tmp, 'vault');
    store = path.join(tmp, STORAGE_DIR_NAME, 'vaults', 'snapshot');
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

  async function seed(edits = 0) {
    await fs.writeFile(path.join(vault, 'note.md'), note);
    expect((await indexer.indexVault(vault, false, tmp, 'snapshot')).success).toBe(true);
    for (let edit = 1; edit <= edits; edit++) {
      await fs.writeFile(path.join(vault, 'note.md'), `${note} Revision ${edit}.`);
      expect((await indexer.indexFile(vault, 'note.md', tmp, 'snapshot')).success).toBe(true);
    }
  }

  const prepare = () => indexer.prepareIndexSnapshot(vault, tmp, 'snapshot');

  async function tablePrototype() {
    const db = await lancedb.connect(path.join(store, 'lancedb'));
    const table = await db.openTable('notes');
    const prototype = Object.getPrototypeOf(table);
    table.close(); db.close();
    return prototype;
  }

  it('exports searchable rows and metadata, removes old files, and never loads embeddings', async () => {
    await seed(8);
    await fs.writeFile(path.join(store, 'file-hashes.json.tmp'), 'interrupted write');
    const liveBefore = await inventory(store);
    vi.clearAllMocks();
    const result = await prepare();
    expect(result.success).toBe(true);
    expect(Embedder.getInstance).not.toHaveBeenCalled();
    expect(result.versionsRemoved.length).toBeGreaterThan(0);
    expect(result.after.files).toBeLessThan(result.before.files);
    expect(result.validation).toMatchObject({ rows: 1, vectorQuery: true, fullTextQuery: true });
    expect(await inventory(store)).toEqual(liveBefore);
    const exported = await inventory(result.snapshotPath);
    expect(exported['file-hashes.json.tmp']).toBeUndefined();
    await expect(fs.stat(path.join(result.snapshotPath, 'index.lock'))).rejects.toThrow();
    for (const name of ['file-hashes.json', 'schema-version.json', 'index-metadata.json']) {
      expect(exported[name]).toBe(liveBefore[name]);
    }

    // A fresh process has neither the original connection nor its caches.
    // Hide the live files so fallback references cannot make this pass.
    await indexer.reset();
    await fs.rename(path.join(store, 'lancedb'), path.join(tmp, 'hidden-live'));
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', `
      const lance = require(${JSON.stringify(require.resolve('@lancedb/lancedb'))});
      (async () => {
        const db = await lance.connect(process.argv[1]);
        const table = await db.openTable('notes');
        const rows = await table.query().toArray();
        const vector = await table.vectorSearch(Array.from(rows[0].vector)).toArray();
        const fts = await table.search('Snapshotmarker', 'fts').toArray();
        console.log(JSON.stringify({rows: rows.length, text: rows[0].text, vector: vector.length, fts: fts.length}));
        table.close(); db.close();
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `, path.join(result.snapshotPath, 'lancedb')]);
    expect(JSON.parse(stdout)).toMatchObject({ rows: 1, vector: 1, fts: 1, text: `${note} Revision 8.` });
  });

  it('reuses identical output without maintenance, versions, or changed payload mtimes', async () => {
    await seed(2);
    const first = await prepare();
    const before = await inventory(first.snapshotPath);
    const manifestStat = await fs.stat(path.join(first.snapshotPath, 'snapshot.json'));
    const optimize = vi.spyOn(await tablePrototype(), 'optimize');
    const second = await prepare();
    expect(second).toEqual({ ...first, reused: true });
    expect(optimize).not.toHaveBeenCalled();
    expect(await inventory(first.snapshotPath)).toEqual(before);
    expect((await fs.stat(path.join(first.snapshotPath, 'snapshot.json'))).mtimeMs).toBe(manifestStat.mtimeMs);
  });

  it('reuses an export after an unchanged vault scan without another compaction', async () => {
    await seed();
    const first = await prepare();
    const before = await inventory(first.snapshotPath);
    const sourceBefore = await inventory(store);
    const optimize = vi.spyOn(await tablePrototype(), 'optimize');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    expect(await indexer.indexVault(vault, false, tmp, 'snapshot')).toMatchObject({ success: true, chunks: 0, maintenancePerformed: false });
    clock.mockRestore();
    expect(await inventory(store)).toEqual(sourceBefore);
    expect(await prepare()).toEqual({ ...first, reused: true });
    expect(optimize).not.toHaveBeenCalled();
    expect(await inventory(first.snapshotPath)).toEqual(before);
  });

  it.each(['', ' \n\t ', '---\ntags: [garden]\n---\n'])(
    'exports successfully after indexing a note with no embeddable content: %j', async content => {
      await seed();
      await fs.writeFile(path.join(vault, 'note.md'), content);
      expect(await indexer.indexFile(vault, 'note.md', tmp, 'snapshot')).toMatchObject({ success: true, chunks: 0 });
      expect(JSON.parse(await fs.readFile(path.join(store, 'file-hashes.json'), 'utf8')))
        .toEqual({ 'note.md': createHash('md5').update(content).digest('hex') });
      const result = await prepare();
      expect(result.validation.rows).toBe(0);
      expect(Object.keys(JSON.parse(await fs.readFile(path.join(result.snapshotPath, 'file-hashes.json'), 'utf8')))).toEqual(['note.md']);
    });

  it('exports a newly created empty note and keeps scan and move bookkeeping consistent', async () => {
    await seed();
    const context = createToolContext(indexer, { vault_path: vault, workspace_path: tmp, vault_id: 'snapshot' });
    await dispatchMcpTool('obsidian_create_note', { file_path: 'empty.md', content: '' }, context);
    const first = await prepare();
    expect(first.validation.rows).toBe(1);
    const hashes = JSON.parse(await fs.readFile(path.join(first.snapshotPath, 'file-hashes.json'), 'utf8'));
    expect(hashes['empty.md']).toBe(createHash('md5').update('').digest('hex'));
    expect((await indexer.indexVault(vault, false, tmp, 'snapshot')).maintenancePerformed).toBe(false);
    expect(await prepare()).toEqual({ ...first, reused: true });

    await fs.rename(path.join(vault, 'empty.md'), path.join(vault, 'moved.md'));
    expect(await indexer.moveFile(vault, 'empty.md', 'moved.md', tmp, 'snapshot')).toMatchObject({ success: true, chunks: 0 });
    const moved = await prepare();
    expect(moved.validation.rows).toBe(1);
    expect(JSON.parse(await fs.readFile(path.join(moved.snapshotPath, 'file-hashes.json'), 'utf8')))
      .toEqual({ 'note.md': hashes['note.md'], 'moved.md': hashes['empty.md'] });
  });

  it.each(['missing metadata', 'timestamp-only touch'])(
    'still reconciles freshness on an unchanged scan after %s', async change => {
      await seed();
      if (change === 'missing metadata') await fs.unlink(path.join(store, 'index-metadata.json'));
      else {
        const later = new Date(Date.now() + 10000);
        await fs.utimes(path.join(vault, 'note.md'), later, later);
      }
      expect((await indexer.checkIndexStaleness(vault, tmp, 'snapshot')).stale).toBe(true);
      expect(await indexer.indexVault(vault, false, tmp, 'snapshot'))
        .toMatchObject({ success: true, chunks: 0, maintenancePerformed: false });
      expect((await indexer.checkIndexStaleness(vault, tmp, 'snapshot')).stale).toBe(false);
      expect((await prepare()).validation.rows).toBe(1);
    });

  it('leaves a published export unchanged while the live database changes and is cleaned up during copying', async () => {
    await seed(2);
    const first = await prepare();
    const before = await inventory(first.snapshotPath);
    const staged = path.join(tmp, 'staged');
    await fs.mkdir(staged);
    await fs.copyFile(path.join(first.snapshotPath, 'file-hashes.json'), path.join(staged, 'file-hashes.json'));
    await fs.writeFile(path.join(vault, 'note.md'), `${note} Changed after capture.`);
    await indexer.indexFile(vault, 'note.md', tmp, 'snapshot');
    const db = await lancedb.connect(path.join(store, 'lancedb'));
    const table = await db.openTable('notes');
    await table.optimize({ cleanupOlderThan: new Date(), deleteUnverified: false });
    table.close(); db.close();
    await fs.cp(path.join(first.snapshotPath, 'lancedb'), path.join(staged, 'lancedb'), { recursive: true });
    const copied = await lancedb.connect(path.join(staged, 'lancedb'));
    const copiedTable = await copied.openTable('notes');
    expect((await copiedTable.query().toArray())[0].text).toBe(`${note} Revision 2.`);
    copiedTable.close(); copied.close();
    expect(await inventory(first.snapshotPath)).toEqual(before);
    const second = await prepare();
    expect(second.snapshotPath).not.toBe(first.snapshotPath);
    expect(second.reused).toBe(false);
  });

  it.each(['edit', 'delete', 'add'])('rejects stale %s input even if timestamps do not advance', async change => {
    await seed();
    if (change === 'delete') await fs.unlink(path.join(vault, 'note.md'));
    else {
      const file = path.join(vault, change === 'add' ? 'new.md' : 'note.md');
      await fs.writeFile(file, `${note} Changed.`);
      await fs.utimes(file, new Date(0), new Date(0));
    }
    await expect(prepare()).rejects.toThrow('Index is stale');
    await expect(fs.stat(path.join(store, 'snapshots'))).rejects.toThrow();
  });

  it('fails for missing indexes and incompatible schema without creating an empty database', async () => {
    await expect(prepare()).rejects.toThrow('No index to export');
    await expect(fs.stat(path.join(store, 'lancedb'))).rejects.toThrow();
    await seed();
    await fs.writeFile(path.join(store, 'schema-version.json'), '{"notesTableSchemaVersion":-1}');
    await expect(prepare()).rejects.toThrow('Incompatible index schema');
  });

  it('rejects corrupted completed exports without overwriting them', async () => {
    await seed();
    const first = await prepare();
    await fs.writeFile(path.join(first.snapshotPath, 'file-hashes.json'), '{}');
    await expect(prepare()).rejects.toThrow('incomplete or modified');
    expect(await fs.readFile(path.join(first.snapshotPath, 'file-hashes.json'), 'utf8')).toBe('{}');
  });

  it('cleans unpublished output after failed maintenance and leaves live data intact', async () => {
    await seed();
    const before = await inventory(store);
    vi.spyOn(await tablePrototype(), 'optimize').mockRejectedValueOnce(new Error('Interrupted maintenance'));
    await expect(prepare()).rejects.toThrow('Interrupted maintenance');
    expect(await fs.readdir(path.join(store, 'snapshots'))).toEqual([]);
    expect(await inventory(store)).toEqual(before);
    expect((await prepare()).success).toBe(true);
  });

  it('cleans abandoned staging directories on reuse while preserving published exports and unrelated entries', async () => {
    await seed();
    const first = await prepare();
    const before = await inventory(first.snapshotPath);
    const root = path.dirname(first.snapshotPath);
    const abandoned = path.join(root, '.preparing-dead01');
    await fs.cp(first.snapshotPath, abandoned, { recursive: true });
    const unrelated = path.join(root, 'keep');
    await fs.mkdir(unrelated);
    await fs.writeFile(path.join(unrelated, 'keep.txt'), 'keep');
    await fs.writeFile(path.join(root, '.preparing-file01'), 'keep');
    await fs.symlink(unrelated, path.join(root, '.preparing-link01'));
    vi.stubEnv('OBSIDIAN_INDEX_LOCK_WAIT_MS', '0');
    await fs.writeFile(path.join(store, 'index.lock'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    await expect(prepare()).rejects.toThrow('Timed out waiting');
    expect((await fs.stat(abandoned)).isDirectory()).toBe(true);
    await fs.unlink(path.join(store, 'index.lock'));
    expect((await prepare()).reused).toBe(true);
    await expect(fs.stat(abandoned)).rejects.toThrow();
    expect(await inventory(first.snapshotPath)).toEqual(before);
    expect(await fs.readFile(path.join(unrelated, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await fs.readFile(path.join(root, '.preparing-file01'), 'utf8')).toBe('keep');
    expect((await fs.lstat(path.join(root, '.preparing-link01'))).isSymbolicLink()).toBe(true);
  });

  it.skipIf(process.platform !== 'linux')('reclaims a lock whose live PID now belongs to a different process start', async () => {
    await seed();
    vi.stubEnv('OBSIDIAN_INDEX_LOCK_WAIT_MS', '0');
    const identity = await processIdentity.getProcessStartIdentity(process.pid);
    expect(identity).toMatch(/^linux:/);
    await fs.writeFile(path.join(store, 'index.lock'), JSON.stringify({
      pid: process.pid, hostname: os.hostname(), createdAt: Date.now(),
      processStartIdentity: identity!.replace(/\d+$/, ticks => String(BigInt(ticks) + 1n)),
    }));
    expect((await prepare()).success).toBe(true);
  });

  it('keeps a live lock when process start identity cannot be read', async () => {
    await seed();
    vi.stubEnv('OBSIDIAN_INDEX_LOCK_WAIT_MS', '0');
    vi.spyOn(processIdentity, 'getProcessStartIdentity').mockResolvedValue(null);
    const lock = { pid: process.pid, hostname: os.hostname(), createdAt: 1, processStartIdentity: 'unavailable' };
    await fs.writeFile(path.join(store, 'index.lock'), JSON.stringify(lock));
    await expect(prepare()).rejects.toThrow('Timed out waiting');
    expect(JSON.parse(await fs.readFile(path.join(store, 'index.lock'), 'utf8'))).toEqual(lock);
  });

  it('refuses unsupported LanceDB releases before reading a manifest', async () => {
    await expect(assertLocalManifest(path.join(tmp, 'missing.manifest'), '0.27.3'))
      .rejects.toThrow('requires LanceDB 0.27.2; installed version is 0.27.3');
  });

  it('rejects tags explicitly and preserves them in the live table', async () => {
    await seed();
    const db = await lancedb.connect(path.join(store, 'lancedb'));
    const table = await db.openTable('notes');
    await (await table.tags()).create('keep-me', await table.version());
    await expect(prepare()).rejects.toThrow('Retained tags: keep-me');
    expect(Object.keys(await (await table.tags()).list())).toEqual(['keep-me']);
    table.close(); db.close();
  });

  it.each([false, true])('rejects shallow clones before maintenance, including mixed local data: %s', async addLocalData => {
    await seed();
    await indexer.reset();
    const external = path.join(tmp, 'external-database');
    await fs.rename(path.join(store, 'lancedb'), external);
    const db = await lancedb.connect(path.join(store, 'lancedb'));
    const table = await db.cloneTable('notes', path.join(external, 'notes.lance'));
    if (addLocalData) {
      const [row] = await table.query().toArray();
      await table.add([{ ...row, id: 'local-row', vector: Array.from(row.vector), entities: [], communities: [] }]);
    }
    const optimize = vi.spyOn(Object.getPrototypeOf(table), 'optimize');
    const externalBefore = await inventory(external);
    const liveBefore = await inventory(store);
    await expect(prepare()).rejects.toThrow('Shallow clones');
    expect(optimize).not.toHaveBeenCalled();
    expect(await inventory(external)).toEqual(externalBefore);
    expect(await inventory(store)).toEqual(liveBefore);
    table.close(); db.close();
  });

  it('rejects corrupt manifests without trying maintenance', async () => {
    await seed();
    const versions = path.join(store, 'lancedb', 'notes.lance', '_versions');
    const file = path.join(versions, (await fs.readdir(versions))[0]);
    await fs.writeFile(file, 'invalid manifest');
    await expect(prepare()).rejects.toThrow('Unsupported or corrupt Lance manifest');
    await expect(fs.stat(path.join(store, 'snapshots'))).rejects.toThrow();
  });

  it('does not expire a live capture lock, and rejects note changes made during preparation', async () => {
    await seed();
    vi.stubEnv('OBSIDIAN_INDEX_LOCK_STALE_MS', '1');
    vi.stubEnv('OBSIDIAN_INDEX_LOCK_WAIT_MS', '40');
    vi.stubEnv('OBSIDIAN_INDEX_LOCK_RETRY_MS', '10');
    const other = new VaultIndexer();
    const prototype = await tablePrototype();
    const original = prototype.optimize;
    vi.spyOn(prototype, 'optimize').mockImplementationOnce(async function (this: lancedb.Table, ...args: unknown[]) {
      await fs.writeFile(path.join(vault, 'note.md'), `${note} Concurrent write.`);
      await expect(other.indexFile(vault, 'note.md', tmp, 'snapshot')).resolves.toMatchObject({ success: false, message: expect.stringContaining('Timed out waiting') });
      return original.apply(this, args);
    });
    const before = await inventory(store);
    await expect(prepare()).rejects.toThrow('Index is stale');
    expect(await inventory(store)).toEqual(before);
    expect(await fs.readdir(path.join(store, 'snapshots'))).toEqual([]);
    await other.reset();
  });

  it('refuses a remote host lock even when old', async () => {
    await seed();
    vi.stubEnv('OBSIDIAN_INDEX_LOCK_WAIT_MS', '0');
    await fs.writeFile(path.join(store, 'index.lock'), JSON.stringify({ pid: 2147483647, hostname: 'other-host', createdAt: 1 }));
    await expect(prepare()).rejects.toThrow('Timed out waiting');
    expect(JSON.parse(await fs.readFile(path.join(store, 'index.lock'), 'utf8')).hostname).toBe('other-host');
  });

  it('times out behind work in the same process without leaving the queue blocked', async () => {
    await seed();
    vi.stubEnv('OBSIDIAN_INDEX_LOCK_WAIT_MS', '10');
    const prototype = await tablePrototype();
    const original = prototype.optimize;
    vi.spyOn(prototype, 'optimize').mockImplementationOnce(async function (this: lancedb.Table, ...args: unknown[]) {
      await expect(prepare()).rejects.toThrow('in-process RAG index lock');
      return original.apply(this, args);
    });
    expect((await prepare()).success).toBe(true);
    expect((await prepare()).reused).toBe(true);
  });

  it('rejects output symlinks and enforces CLI and MCP path boundaries with structured failures', async () => {
    await seed();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-outside-'));
    try {
      await fs.symlink(outside, path.join(store, 'snapshots'));
      await expect(prepare()).rejects.toThrow('symbolic links');
      expect(await fs.readdir(outside)).toEqual([]);
      const context = createToolContext(indexer, { vault_path: vault, workspace_path: tmp, vault_id: 'snapshot' });
      const cli = await dispatchCliTool(['obsidian_prepare_index_snapshot', '--workspace_path', outside], context, async () => '');
      expect(cli.exitCode).toBe(1);
      expect(JSON.parse(cli.output!)).toMatchObject({ success: false, error: { message: expect.stringContaining('boundary') } });
      const mcp = await dispatchMcpTool('obsidian_prepare_index_snapshot', { vault_path: outside }, context);
      expect(mcp.isError).toBe(true);
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });

  it('prepares an empty indexed vault without embeddings or rebuilding', async () => {
    await indexer.indexVault(vault, false, tmp, 'snapshot');
    vi.clearAllMocks();
    const result = await prepare();
    expect(result.validation.rows).toBe(0);
    expect(Embedder.getInstance).not.toHaveBeenCalled();
  });

  it('recovers after a CLI process is killed during capture and returns machine-readable CLI failures', async () => {
    await seed(2);
    const before = await inventory(store);
    const cliPath = path.resolve('dist/index.js');
    const env = {
      ...process.env,
      OBSIDIAN_VAULT_PATH: vault,
      OBSIDIAN_WORKSPACE_PATH: tmp,
      OBSIDIAN_VAULT_ID: 'snapshot',
      OBSIDIAN_ALLOWED_VAULTS: tmp,
      OBSIDIAN_INDEX_LOCK_WAIT_MS: '40',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
    };
    // Pause the real CLI at its first payload copy, after acquiring its lock.
    const child = spawn(process.execPath, ['-e', `
      const fs = require('node:fs/promises');
      fs.cp = async () => {
        process.send('capturing');
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      };
      process.argv = [process.execPath, ${JSON.stringify(cliPath)}, 'obsidian_prepare_index_snapshot'];
      require(${JSON.stringify(cliPath)}).main();
    `], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const exited = once(child, 'exit');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await Promise.race([
        once(child, 'message').then(([message]) => message),
        exited.then(() => { throw new Error('CLI exited before capture'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CLI capture timed out')), 10000); }),
      ]);
      expect(ready).toBe('capturing');
      if (process.platform === 'linux') {
        const lock = JSON.parse(await fs.readFile(path.join(store, 'index.lock'), 'utf8'));
        expect(lock.processStartIdentity).toBe(await processIdentity.getProcessStartIdentity(child.pid!));
        expect(lock.processStartIdentity).toMatch(/^linux:/);
      }
      vi.stubEnv('OBSIDIAN_INDEX_LOCK_STALE_MS', '1');
      vi.stubEnv('OBSIDIAN_INDEX_LOCK_WAIT_MS', '30');
      await expect(indexer.indexVault(vault, false, tmp, 'snapshot')).rejects.toThrow('Timed out waiting');
    } finally {
      clearTimeout(timer);
      child.kill('SIGKILL');
      await exited;
    }
    const unfinished = await fs.readdir(path.join(store, 'snapshots'));
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0]).toMatch(/^\.preparing-/);
    expect(await inventory(store)).toEqual(before);

    const { stdout } = await promisify(execFile)(process.execPath, [cliPath, 'obsidian_prepare_index_snapshot'], { env });
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ success: true, reused: false, validation: { rows: 1 } });
    await expect(fs.stat(path.join(store, 'snapshots', unfinished[0]))).rejects.toThrow();
    const context = createToolContext(indexer, { vault_path: vault, workspace_path: tmp, vault_id: 'snapshot' });
    const mcp = await dispatchMcpTool('obsidian_prepare_index_snapshot', {}, context);
    expect(JSON.parse(mcp.content[0].text)).toEqual({ ...result, reused: true });

    await fs.writeFile(path.join(vault, 'note.md'), `${note} Unindexed.`);
    await expect(promisify(execFile)(process.execPath, [cliPath, 'obsidian_prepare_index_snapshot'], { env }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('"success":false') });
  }, 20000);
});
