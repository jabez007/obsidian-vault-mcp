import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as lancedb from '@lancedb/lancedb';
import { NotePolicy, IGNORE_FILE_NAME } from '../src/note-policy';
import { VaultIndexer, STORAGE_DIR_NAME } from '../src/rag/store';
import { Embedder } from '../src/rag/embedder';
import { createToolContext } from '../src/index';
import { dispatchCliTool, dispatchMcpTool } from '../src/tools/dispatch';

vi.mock('../src/rag/embedder', () => ({
  Embedder: { getInstance: vi.fn(() => ({
    embed: vi.fn(async () => new Array(384).fill(0.1)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => new Array(384).fill(0.1))),
  })) },
}));

describe('vault ignore policy', () => {
  let tmp: string;
  let vault: string;
  let store: string;
  let indexer: VaultIndexer;
  const text = 'Policyuniquemarker records enough information about tomato gardening to produce a searchable note.';
  const policyFile = () => path.join(vault, IGNORE_FILE_NAME);
  const scan = () => indexer.indexVault(vault, false, tmp, 'policy');
  const query = () => indexer.search('Policyuniquemarker', vault, 20, tmp, 'policy');
  const prepare = (rulesText?: string) => indexer.prepareIndexSnapshot(vault, tmp, 'policy', rulesText);
  const context = () => createToolContext(indexer, { vault_path: vault, workspace_path: tmp, vault_id: 'policy' });
  const metadataPath = () => path.join(store, 'index-metadata.json');
  const metadata = async () => JSON.parse(await fs.readFile(metadataPath(), 'utf8'));
  const env = () => ({ ...process.env, OBSIDIAN_VAULT_PATH: vault, OBSIDIAN_WORKSPACE_PATH: tmp,
    OBSIDIAN_VAULT_ID: 'policy', OBSIDIAN_ALLOWED_VAULTS: tmp, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' });

  async function write(relative: string, content = text) {
    await fs.mkdir(path.dirname(path.join(vault, relative)), { recursive: true });
    await fs.writeFile(path.join(vault, relative), content);
  }

  async function rows() {
    const db = await lancedb.connect(path.join(store, 'lancedb'));
    const table = await db.openTable('notes');
    try { return JSON.parse(JSON.stringify(await table.query().toArray())); } finally { table.close(); db.close(); }
  }

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-ignore-'));
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

  it('uses portable, case-sensitive gitignore matching without widening built-in exclusions', () => {
    const policy = new NotePolicy('/drafts/\n*.tmp.md\nsources/**/raw*.md\n\\!literal.md\n\\#literal.md');
    for (const file of ['drafts/a.md', 'drafts\\nested\\a.md', 'a.tmp.md', 'nested/a.tmp.md',
      'sources/raw.md', 'sources/a/raw1.md', '!literal.md', '#literal.md', '.hidden.md', 'a/.hidden/n.md', 'UPPER.MD']) {
      expect(policy.includes(file), file).toBe(false);
    }
    for (const file of ['Drafts/a.md', 'nested/drafts/a.md', 'note.md']) expect(policy.includes(file), file).toBe(true);
  });

  it('normalizes BOM, line endings, comments, and blank lines while preserving meaningful escapes and whitespace', () => {
    expect(new NotePolicy('').fingerprint).toBe(new NotePolicy('# comment\r\n \t\r\n').fingerprint);
    expect(new NotePolicy('\uFEFF# comment\r\n/drafts/\r\n').fingerprint).toBe(new NotePolicy('/drafts/').fingerprint);
    expect(new NotePolicy('name\\ ').fingerprint).not.toBe(new NotePolicy('name ').fingerprint);
    expect(new NotePolicy('a\nb').fingerprint).not.toBe(new NotePolicy('b\na').fingerprint);
    expect(() => new NotePolicy('# comment\n!drafts/')).toThrow(`${IGNORE_FILE_NAME}:2`);
    expect(() => new NotePolicy('a\0b')).toThrow(`${IGNORE_FILE_NAME}:1`);
  });

  it('excludes notes from every discovery tool and RAG while retaining them as existing link targets', async () => {
    await write('note.md', text + ' [[drafts/target]] [[missing]]');
    await write('drafts/target.md', text + ' [[note]]');
    await write('linked.md', text + ' [[note]]');
    await write(IGNORE_FILE_NAME, '/drafts/');
    await scan();
    expect((await query()).map(row => row.path).sort()).toEqual(['linked.md', 'note.md']);
    for (const [name, args] of [
      ['obsidian_list_notes', {}], ['obsidian_search_notes', { query: 'Policyuniquemarker' }],
      ['obsidian_get_backlinks', { file_name: 'note' }],
    ] as const) {
      const result = await dispatchMcpTool(name, args, context());
      expect(result.content[0].text).not.toContain('drafts/target.md');
      expect(result.isError).not.toBe(true);
    }
    const broken = await dispatchMcpTool('obsidian_get_broken_links', {}, context());
    expect(broken.content[0].text).toContain('[[missing]]');
    expect(broken.content[0].text).not.toContain('[[drafts/target]]');
    const before = await rows();
    const read = await dispatchMcpTool('obsidian_read_note', { file_path: 'drafts/target.md' }, context());
    expect(read.content[0].text).toContain(text);
    expect(await rows()).toEqual(before);
  });

  it('blocks changed rules before returning content and reconciles both ways without note mtime changes', async () => {
    await write('note.md'); await write('drafts/target.md'); await scan();
    const before = await fs.stat(path.join(vault, 'drafts/target.md'));
    await write(IGNORE_FILE_NAME, '/drafts/');
    await expect(query()).rejects.toThrow('obsidian_rag_index');
    const mcp = await dispatchMcpTool('obsidian_rag_query', { query: 'Policyuniquemarker' }, context());
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0].text).not.toContain(text);
    expect((await dispatchCliTool(['obsidian_rag_query', '--query', 'Policyuniquemarker'], context(), async () => '')).exitCode).toBe(1);
    await scan();
    expect((await rows()).map(row => row.path)).toEqual(['note.md']);
    await write(IGNORE_FILE_NAME, '');
    await scan();
    expect((await rows()).map(row => row.path).sort()).toEqual(['drafts/target.md', 'note.md']);
    expect((await fs.stat(path.join(vault, 'drafts/target.md'))).mtimeMs).toBe(before.mtimeMs);
  });

  it('never lets a single-note edit or move certify changed rules', async () => {
    await write('note.md'); await write('drafts/target.md'); await scan();
    await write(IGNORE_FILE_NAME, '/drafts/');
    await indexer.indexFile(vault, 'note.md', tmp, 'policy');
    expect((await metadata()).policyReconciled).toBe(false);
    await expect(query()).rejects.toThrow('obsidian_rag_index');
    await fs.rename(path.join(vault, 'note.md'), path.join(vault, 'moved.md'));
    await indexer.moveFile(vault, 'note.md', 'moved.md', tmp, 'policy');
    await expect(query()).rejects.toThrow('obsidian_rag_index');
    await scan();
    expect((await query()).map(row => row.path)).toEqual(['moved.md']);
  });

  it('excludes explicit creates and edits, removes moves into ignored folders, and indexes moves out', async () => {
    await write(IGNORE_FILE_NAME, '/drafts/');
    await write('note.md'); await scan();
    await dispatchMcpTool('obsidian_create_note', { file_path: 'drafts/new.md', content: text }, context());
    await dispatchMcpTool('obsidian_append_note', { file_path: 'drafts/new.md', content: text }, context());
    expect((await rows()).map(row => row.path)).toEqual(['note.md']);
    await dispatchMcpTool('obsidian_move_note', { source_path: 'note.md', dest_path: 'drafts/moved.md' }, context());
    expect(await rows()).toEqual([]);
    await dispatchMcpTool('obsidian_move_note', { source_path: 'drafts/moved.md', dest_path: 'restored.md' }, context());
    expect((await query()).map(row => row.path)).toEqual(['restored.md']);
  });

  it.each(['!drafts/', 'bad\0pattern', Buffer.from([0xff]), 'directory', 'dangling symlink'])(
    'rejects invalid or unreadable rules without changing rows and keeps explicit edits usable: %j', async rules => {
      await write('note.md'); await scan();
      const before = await rows();
      const beforeMetadata = await fs.readFile(metadataPath(), 'utf8');
      if (rules === 'directory') await fs.mkdir(policyFile());
      else if (rules === 'dangling symlink') await fs.symlink(path.join(vault, 'missing-policy'), policyFile());
      else await fs.writeFile(policyFile(), rules);
      await expect(scan()).rejects.toThrow(IGNORE_FILE_NAME);
      const indexed = await indexer.indexFile(vault, 'note.md', tmp, 'policy');
      expect(indexed.success).toBe(false);
      for (const [name, args] of [['obsidian_list_notes', {}], ['obsidian_search_notes', { query: 'Policy' }],
        ['obsidian_get_backlinks', { file_name: 'note' }], ['obsidian_get_broken_links', {}],
        ['obsidian_rag_query', { query: 'Policy' }]] as const) {
        expect((await dispatchMcpTool(name, args, context())).isError).toBe(true);
      }
      const edited = await dispatchMcpTool('obsidian_append_note', { file_path: 'note.md', content: 'Saved edit.' }, context());
      expect(edited.isError).not.toBe(true);
      expect(edited.content[0].text).toContain('indexing failed');
      expect(await fs.readFile(path.join(vault, 'note.md'), 'utf8')).toContain('Saved edit.');
      const moved = await dispatchMcpTool('obsidian_move_note', { source_path: 'note.md', dest_path: 'moved.md' }, context());
      expect(moved.isError).not.toBe(true);
      expect(moved.content[0].text).toContain('Note moved, but indexing failed');
      expect(await fs.readFile(path.join(vault, 'moved.md'), 'utf8')).toContain('Saved edit.');
      expect(await rows()).toEqual(before);
      expect(await fs.readFile(metadataPath(), 'utf8')).toBe(beforeMetadata);
    });

  it.each(['obsidian_create_note', 'obsidian_append_note', 'obsidian_update_frontmatter',
    'obsidian_replace_section', 'obsidian_insert_at_heading', 'obsidian_replace_in_note'])(
    'protects the ignore file and symlink aliases through %s', async name => {
      await write(IGNORE_FILE_NAME, '# protected');
      await fs.symlink(policyFile(), path.join(vault, 'alias.md'));
      for (const file_path of [IGNORE_FILE_NAME, 'alias.md']) {
        const response = await dispatchMcpTool(name, { file_path, content: 'changed', overwrite: true,
          heading: 'Heading', old_text: '# protected', new_text: 'changed', updates: { a: 'b' } }, context());
        expect(response.isError).toBe(true);
        expect(response.content[0].text).toContain('Edit it directly');
      }
      expect(await fs.readFile(policyFile(), 'utf8')).toBe('# protected');
    });

  it('rejects moves of the ignore file, overwrites, and aliases before changing any files', async () => {
    await write(IGNORE_FILE_NAME, '# protected'); await write('note.md');
    await fs.symlink(policyFile(), path.join(vault, 'alias.md'));
    for (const [source_path, dest_path] of [[IGNORE_FILE_NAME, 'moved.md'], ['note.md', IGNORE_FILE_NAME],
      ['alias.md', 'moved.md'], ['note.md', 'alias.md']]) {
      const result = await dispatchMcpTool('obsidian_move_note', { source_path, dest_path, overwrite: true }, context());
      expect(result.isError).toBe(true);
    }
    expect(await fs.readFile(path.join(vault, 'note.md'), 'utf8')).toBe(text);
    expect(await fs.readFile(policyFile(), 'utf8')).toBe('# protected');
  });

  it('matches symlinks by the addressed path and keeps independent vault rules isolated', async () => {
    await write('drafts/target.md');
    await write(IGNORE_FILE_NAME, '/drafts/');
    await fs.symlink(path.join(vault, 'drafts'), path.join(vault, 'alias'));
    await scan();
    expect((await rows()).map(row => row.path)).toEqual(['alias/target.md']);
    const otherVault = path.join(tmp, 'other'); await fs.mkdir(otherVault);
    await fs.writeFile(path.join(otherVault, 'note.md'), text);
    await indexer.indexVault(otherVault, false, tmp, 'other');
    expect((await indexer.search('Policy', otherVault, 5, tmp, 'other')).map(row => row.path)).toEqual(['note.md']);
    expect((await query()).map(row => row.path)).toEqual(['alias/target.md']);
  });

  it('upgrades legacy metadata with one reconciliation and reuses unchanged embeddings', async () => {
    await write('note.md'); await scan();
    const legacy = await metadata(); delete legacy.metadataVersion; delete legacy.rulesFingerprint; delete legacy.policyReconciled;
    await fs.writeFile(metadataPath(), JSON.stringify(legacy));
    await expect(query()).rejects.toThrow('obsidian_rag_index');
    await expect(prepare()).rejects.toThrow('obsidian_rag_index');
    vi.clearAllMocks();
    expect(await scan()).toMatchObject({ success: true, chunks: 0 });
    expect(vi.mocked(Embedder.getInstance).mock.results.flatMap(r => r.value?.embedBatch?.mock?.calls ?? [])).toEqual([]);
    expect((await query()).length).toBe(1);
  });

  it('rejects a rules change during indexing and remains blocked if the old rules are restored', async () => {
    await write('note.md'); await scan();
    await write('note.md', text + ' changed');
    vi.mocked(Embedder.getInstance).mockImplementationOnce(() => ({
      embedBatch: async (texts: string[]) => { await write(IGNORE_FILE_NAME, '/drafts/'); return texts.map(() => Array(384).fill(0.1)); },
    }) as any);
    await expect(scan()).rejects.toThrow('changed during');
    expect((await metadata()).policyReconciled).toBe(false);
    await write(IGNORE_FILE_NAME, '');
    await indexer.indexFile(vault, 'note.md', tmp, 'policy');
    await expect(query()).rejects.toThrow('obsidian_rag_index');
    await scan();
    expect((await query()).length).toBe(1);
  });

  it('rejects query results if rules change during embedding', async () => {
    await write('note.md'); await scan();
    vi.mocked(Embedder.getInstance).mockImplementationOnce(() => ({
      embed: async () => { await write(IGNORE_FILE_NAME, '/drafts/'); return Array(384).fill(0.1); },
    }) as any);
    await expect(query()).rejects.toThrow('changed during');
  });

  it('discards discovery results if rules change while note contents are read', async () => {
    await write('note.md');
    const assertUnchanged = NotePolicy.prototype.assertUnchanged;
    vi.spyOn(NotePolicy.prototype, 'assertUnchanged').mockImplementationOnce(async function(this: NotePolicy, vaultPath: string) {
      await write(IGNORE_FILE_NAME, '/drafts/');
      return assertUnchanged.call(this, vaultPath);
    });
    const result = await dispatchMcpTool('obsidian_search_notes', { query: 'Policyuniquemarker' }, context());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('changed during');
    expect(result.content[0].text).not.toContain(text);
  });

  it('keeps queries blocked after a failed scan even when rules are restored', async () => {
    await write('note.md'); await scan();
    await write(IGNORE_FILE_NAME, '/drafts/');
    await write('new.md');
    vi.mocked(Embedder.getInstance).mockImplementationOnce(() => ({
      embedBatch: async () => { throw new Error('Embedding failed'); },
      embed: async () => { throw new Error('Embedding failed'); },
    }) as any);
    expect(await scan()).toMatchObject({ success: false });
    await write(IGNORE_FILE_NAME, '');
    await expect(query()).rejects.toThrow('obsidian_rag_index');
    await scan();
    expect((await query()).map(row => row.path).sort()).toEqual(['new.md', 'note.md']);
  });

  it('keeps reconciliation dirty if rules change while the final metadata is published', async () => {
    await write('note.md'); await scan();
    const cli = path.resolve('dist/index.js');
    await expect(promisify(execFile)(process.execPath, ['-e', `
      const fs = require('node:fs/promises');
      const rename = fs.rename;
      let changed = false;
      fs.rename = async (from, to) => {
        await rename(from, to);
        if (!changed && String(to).endsWith('index-metadata.json') && JSON.parse(await fs.readFile(to, 'utf8')).policyReconciled === true) {
          changed = true;
          await fs.writeFile(${JSON.stringify(policyFile())}, '/drafts/');
        }
      };
      process.argv = [process.execPath, ${JSON.stringify(cli)}, 'obsidian_rag_index'];
      require(${JSON.stringify(cli)}).main();
    `], { env: env() })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('changed during') });
    expect((await metadata()).policyReconciled).toBe(false);
    await write(IGNORE_FILE_NAME, '');
    await expect(query()).rejects.toThrow('obsidian_rag_index');
  });

  it('exports fingerprinted snapshots, validates staged text, and reuses equivalent rules', async () => {
    await write('note.md'); await write(IGNORE_FILE_NAME, '/drafts/'); await scan();
    const first = await prepare('# staged\r\n/drafts/\r\n');
    expect(first.rulesFingerprint).toBe((await metadata()).rulesFingerprint);
    const manifest = JSON.parse(await fs.readFile(path.join(first.snapshotPath, 'snapshot.json'), 'utf8'));
    expect(manifest).toMatchObject({ policyVersion: 2, rulesFingerprint: first.rulesFingerprint });
    await expect(prepare('')).rejects.toThrow('Supplied ignore rules');
    await write(IGNORE_FILE_NAME, '# edited comments\n/drafts/\n');
    expect(await prepare()).toMatchObject({ sourceFingerprint: first.sourceFingerprint, reused: true });
    await write(IGNORE_FILE_NAME, '/other/');
    await expect(prepare()).rejects.toThrow('obsidian_rag_index');
    await scan();
    expect((await prepare()).sourceFingerprint).not.toBe(first.sourceFingerprint);
  });

  it('checks every snapshot row against policy even when the recorded hashes look valid', async () => {
    await write('note.md'); await write(IGNORE_FILE_NAME, '/drafts/'); await scan();
    const db = await lancedb.connect(path.join(store, 'lancedb'));
    const table = await db.openTable('notes');
    await table.update({ where: "path = 'note.md'", values: { path: 'drafts/leaked.md' } });
    table.close(); db.close();
    await expect(prepare()).rejects.toThrow('excluded path');
    await scan();
    expect((await rows()).some(row => row.path === 'drafts/leaked.md')).toBe(false);
  });

  it('refuses snapshots if rules change during maintenance and never publishes incomplete output', async () => {
    await write('note.md'); await scan();
    const db = await lancedb.connect(path.join(store, 'lancedb')); const table = await db.openTable('notes');
    const prototype = Object.getPrototypeOf(table); table.close(); db.close();
    const optimize = prototype.optimize;
    vi.spyOn(prototype, 'optimize').mockImplementationOnce(async function(this: any, ...args: any[]) {
      await write(IGNORE_FILE_NAME, '/drafts/');
      return optimize.apply(this, args);
    });
    await expect(prepare()).rejects.toThrow('changed during');
    expect(await fs.readdir(path.join(store, 'snapshots'))).toEqual([]);
  });

  it('returns real CLI errors before loading embeddings for mismatched query and staged export rules', async () => {
    await write('note.md'); await scan();
    const cli = path.resolve('dist/index.js');
    await expect(promisify(execFile)(process.execPath, [cli, 'obsidian_prepare_index_snapshot', '--rules_text', '/drafts/'], { env: env() }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Supplied ignore rules') });
    await write(IGNORE_FILE_NAME, '/drafts/');
    await expect(promisify(execFile)(process.execPath, [cli, 'obsidian_rag_query', '--query', 'Policy'], { env: env() }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('obsidian_rag_index') });
  });

  it('keeps reconciliation dirty after a real indexing process is killed', async () => {
    await write('note.md'); await scan();
    const cli = path.resolve('dist/index.js');
    // Pause at the durable dirty-marker rename, before table mutations or model loading.
    const child = spawn(process.execPath, ['-e', `
      const fs = require('node:fs/promises');
      const rename = fs.rename;
      fs.rename = async (from, to) => {
        await rename(from, to);
        if (String(to).endsWith('index-metadata.json') && JSON.parse(await fs.readFile(to, 'utf8')).policyReconciled === false) {
          process.send('dirty'); setInterval(() => {}, 1000); await new Promise(() => {});
        }
      };
      process.argv = [process.execPath, ${JSON.stringify(cli)}, 'obsidian_rag_index'];
      require(${JSON.stringify(cli)}).main();
    `], { env: env(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const exited = once(child, 'exit');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(await Promise.race([once(child, 'message').then(([msg]) => msg),
        exited.then(() => { throw new Error('Index process exited before writing dirty metadata'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Index pause timed out')), 5000); }),
      ])).toBe('dirty');
    } finally { clearTimeout(timer); child.kill('SIGKILL'); await exited; }
    expect((await metadata()).policyReconciled).toBe(false);
    await expect(query()).rejects.toThrow('obsidian_rag_index');
    await scan();
    expect((await query()).length).toBe(1);
  });
});
