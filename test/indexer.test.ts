import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { LEGACY_STORAGE_DIR_NAME, STORAGE_DIR_NAME, VaultIndexer } from '../src/rag/store';
import md5 from 'md5';

// Mock the embedder to avoid loading real models during tests. Texts
// containing the FAILEMBED marker are rejected so tests can exercise
// partial embedding failures.
vi.mock('../src/rag/embedder', () => ({
  Embedder: {
    getInstance: () => ({
      embed: vi.fn().mockImplementation((text: string) =>
        text.includes('FAILEMBED')
          ? Promise.reject(new Error('mock embed failure'))
          : Promise.resolve(new Array(384).fill(0.1))
      ),
      embedBatch: vi.fn().mockImplementation((texts: string[]) =>
        texts.some((text) => text.includes('FAILEMBED'))
          ? Promise.reject(new Error('mock embed failure'))
          : Promise.resolve(texts.map(() => new Array(384).fill(0.1)))
      ),
    })
  }
}));

// Global mock for os.homedir to allow control in tests
let mockHomedir: string | null = null;
const allowedVaultEnvKeys = [
  'OBSIDIAN_ALLOWED_VAULTS',
  'CODEX_OBSIDIAN_ALLOWED_VAULTS',
  'GEMINI_OBSIDIAN_ALLOWED_VAULTS',
] as const;
const originalAllowedVaultEnv = Object.fromEntries(
  allowedVaultEnvKeys.map((key) => [key, process.env[key]]),
);
const indexLockEnvKeys = [
  'OBSIDIAN_INDEX_LOCK_WAIT_MS',
  'CODEX_OBSIDIAN_INDEX_LOCK_WAIT_MS',
  'GEMINI_OBSIDIAN_INDEX_LOCK_WAIT_MS',
  'OBSIDIAN_INDEX_LOCK_STALE_MS',
  'CODEX_OBSIDIAN_INDEX_LOCK_STALE_MS',
  'GEMINI_OBSIDIAN_INDEX_LOCK_STALE_MS',
  'OBSIDIAN_INDEX_LOCK_RETRY_MS',
  'CODEX_OBSIDIAN_INDEX_LOCK_RETRY_MS',
  'GEMINI_OBSIDIAN_INDEX_LOCK_RETRY_MS',
] as const;
const originalIndexLockEnv = Object.fromEntries(
  indexLockEnvKeys.map((key) => [key, process.env[key]]),
);
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: () => mockHomedir || actual.homedir(),
  };
});

describe('VaultIndexer path resolution and storage', () => {
  let tempDir: string;
  let vaultPath: string;
  let workspacePath: string;
  let indexer: VaultIndexer;

  beforeEach(async () => {
    mockHomedir = null;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-vault-mcp-test-'));
    vaultPath = path.join(tempDir, 'my-vault');
    workspacePath = path.join(tempDir, 'my-workspace');
    await fs.mkdir(vaultPath, { recursive: true });
    await fs.mkdir(workspacePath, { recursive: true });
    indexer = new VaultIndexer();
  });

  afterEach(async () => {
    // Reset indexer state
    if (indexer) {
      await indexer.reset();
    }
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    mockHomedir = null;
    for (const key of allowedVaultEnvKeys) {
      const originalValue = originalAllowedVaultEnv[key];
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
    for (const key of indexLockEnvKeys) {
      const originalValue = originalIndexLockEnv[key];
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
  });

  function getVaultStorePath(vaultId = md5(path.resolve(vaultPath))) {
    return path.join(workspacePath, STORAGE_DIR_NAME, 'vaults', vaultId);
  }

  it('uses workspace_path when provided', async () => {
    // Add a note long enough to be indexed
    await fs.writeFile(path.join(vaultPath, 'note.md'), 'This is a sufficiently long note to pass the minimum chunk size filter of forty characters.', 'utf-8');
    
    await indexer.indexVault(vaultPath, false, workspacePath);

    const vaultHash = md5(path.resolve(vaultPath));
    const expectedDbPath = path.join(workspacePath, STORAGE_DIR_NAME, 'vaults', vaultHash, 'lancedb');
    const expectedHashPath = path.join(workspacePath, STORAGE_DIR_NAME, 'vaults', vaultHash, 'file-hashes.json');

    const dbExists = await fs.stat(expectedDbPath).then(() => true).catch(() => false);
    const hashExists = await fs.stat(expectedHashPath).then(() => true).catch(() => false);

    expect(dbExists).toBe(true);
    expect(hashExists).toBe(true);
  });

  it('uses vault_id when provided, overriding MD5 hash of vault path', async () => {
    // Add a note long enough to be indexed
    await fs.writeFile(path.join(vaultPath, 'note.md'), 'This is a sufficiently long note to pass the minimum chunk size filter of forty characters.', 'utf-8');
    
    const customVaultId = 'my-shared-vault-id';
    await indexer.indexVault(vaultPath, false, workspacePath, customVaultId);

    // Vault hash should be our custom ID, not the MD5 hash
    const expectedDbPath = path.join(workspacePath, STORAGE_DIR_NAME, 'vaults', customVaultId, 'lancedb');
    const expectedHashPath = path.join(workspacePath, STORAGE_DIR_NAME, 'vaults', customVaultId, 'file-hashes.json');

    const dbExists = await fs.stat(expectedDbPath).then(() => true).catch(() => false);
    const hashExists = await fs.stat(expectedHashPath).then(() => true).catch(() => false);

    expect(dbExists).toBe(true);
    expect(hashExists).toBe(true);

    // Ensure it used exactly our ID in the vaults directory
    const vaultsDir = path.join(workspacePath, STORAGE_DIR_NAME, 'vaults');
    const folders = await fs.readdir(vaultsDir);
    expect(folders).toContain(customVaultId);
    expect(folders.length).toBe(1);
  });

  it('rejects malicious vault_id with path traversal or separators', async () => {
    const maliciousIds = ['../escape', 'foo/bar', 'vault\\id', '..', '/etc/passwd'];
    
    for (const maliciousId of maliciousIds) {
      await expect(indexer.indexVault(vaultPath, false, workspacePath, maliciousId))
        .rejects.toThrow('Invalid vault_id');
    }

    // Ensure no directories were created for malicious IDs
    const vaultsDir = path.join(workspacePath, STORAGE_DIR_NAME, 'vaults');
    const exists = await fs.stat(vaultsDir).then(() => true).catch(() => false);
    if (exists) {
      const folders = await fs.readdir(vaultsDir);
      expect(folders.length).toBe(0);
    }
  });

  it('uses hashed global cache when workspace_path is not provided', async () => {
    // Add a note long enough to be indexed
    await fs.writeFile(path.join(vaultPath, 'note.md'), 'This is a sufficiently long note to pass the minimum chunk size filter of forty characters.', 'utf-8');

    const vaultHash = md5(path.resolve(vaultPath));
    // Set the mock homedir to our temp test dir
    mockHomedir = tempDir;
    const expectedGlobalPath = path.join(tempDir, STORAGE_DIR_NAME, 'vaults', vaultHash);
    
    await indexer.indexVault(vaultPath, false);

    const dbExists = await fs.stat(path.join(expectedGlobalPath, 'lancedb')).then(() => true).catch(() => false);
    const hashExists = await fs.stat(path.join(expectedGlobalPath, 'file-hashes.json')).then(() => true).catch(() => false);

    expect(dbExists).toBe(true);
    expect(hashExists).toBe(true);
  });

  it('times out when another live process owns the vault index lock', async () => {
    await fs.writeFile(path.join(vaultPath, 'note.md'), 'This note is long enough to trigger indexing while a live lock exists.', 'utf-8');
    const storePath = getVaultStorePath();
    await fs.mkdir(storePath, { recursive: true });
    await fs.writeFile(
      path.join(storePath, 'index.lock'),
      JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: 'active-test-lock' }),
      'utf-8',
    );
    process.env.OBSIDIAN_INDEX_LOCK_WAIT_MS = '20';
    process.env.OBSIDIAN_INDEX_LOCK_RETRY_MS = '10';
    process.env.OBSIDIAN_INDEX_LOCK_STALE_MS = '60000';

    await expect(indexer.indexVault(vaultPath, true, workspacePath))
      .rejects.toThrow(/Timed out waiting for RAG index lock/);
  });

  it('removes a stale vault index lock before indexing', async () => {
    await fs.writeFile(path.join(vaultPath, 'note.md'), 'This note is long enough to be indexed after a stale lock is cleared.', 'utf-8');
    const storePath = getVaultStorePath();
    const lockPath = path.join(storePath, 'index.lock');
    await fs.mkdir(storePath, { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: Date.now() - 10000, token: 'stale-test-lock' }),
      'utf-8',
    );
    process.env.OBSIDIAN_INDEX_LOCK_WAIT_MS = '1000';
    process.env.OBSIDIAN_INDEX_LOCK_RETRY_MS = '10';
    process.env.OBSIDIAN_INDEX_LOCK_STALE_MS = '1';

    const result = await indexer.indexVault(vaultPath, true, workspacePath);

    expect(result.success).toBe(true);
    await expect(fs.stat(lockPath)).rejects.toThrow();
  });

  it('clears a content-less lock file after its grace period', async () => {
    await fs.writeFile(path.join(vaultPath, 'note.md'), 'This note is long enough to be indexed after an empty lock is cleared.', 'utf-8');
    const storePath = getVaultStorePath();
    const lockPath = path.join(storePath, 'index.lock');
    await fs.mkdir(storePath, { recursive: true });
    await fs.writeFile(lockPath, '', 'utf-8');
    const past = new Date(Date.now() - 10000);
    await fs.utimes(lockPath, past, past);
    process.env.OBSIDIAN_INDEX_LOCK_WAIT_MS = '1000';
    process.env.OBSIDIAN_INDEX_LOCK_RETRY_MS = '10';
    process.env.OBSIDIAN_INDEX_LOCK_STALE_MS = '60000';

    const result = await indexer.indexVault(vaultPath, true, workspacePath);

    expect(result.success).toBe(true);
    await expect(fs.stat(lockPath)).rejects.toThrow();
  });

  it('successfully indexes and searches a mock vault', async () => {
    // Create a mock note
    const notePath = path.join(vaultPath, 'test-note.md');
    await fs.writeFile(notePath, '---\ntitle: Test\n---\nThis is a test note about cats. Cats are very interesting animals that many people keep as pets in their homes.', 'utf-8');

    const result = await indexer.indexVault(vaultPath, true, workspacePath);
    
    expect(result.success).toBe(true);
    expect(result.chunks).toBeGreaterThan(0);

    const searchResults = await indexer.search('cats', vaultPath, 5, workspacePath);
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0].path).toBe('test-note.md');
    expect(searchResults[0].text).toContain('cats');
  });

  it('keeps row count stable when force reindexing an existing vault', async () => {
    await fs.writeFile(
      path.join(vaultPath, 'note.md'),
      'This is a sufficiently long note to pass the minimum chunk size filter and should only appear once after repeated full reindexes.',
      'utf-8',
    );

    const firstResult = await indexer.indexVault(vaultPath, true, workspacePath);
    const secondResult = await indexer.indexVault(vaultPath, true, workspacePath);

    const lancedb = await import('@lancedb/lancedb');
    const vaultHash = md5(path.resolve(vaultPath));
    const dbPath = path.join(workspacePath, STORAGE_DIR_NAME, 'vaults', vaultHash, 'lancedb');
    const hashPath = path.join(workspacePath, STORAGE_DIR_NAME, 'vaults', vaultHash, 'file-hashes.json');

    const readIndexState = async () => {
      const db = await lancedb.connect(dbPath);
      try {
        const table = await db.openTable('notes');
        const rowCount = await table.countRows();
        const indices = await table.listIndices();
        const ftsIndex = indices.find((idx: any) => idx.indexType === 'FTS' && idx.columns.includes('embedding_text'));
        return { rowCount, ftsIndex };
      } finally {
        if (typeof db.close === 'function') {
          db.close();
        }
      }
    };

    const firstRebuildState = await readIndexState();

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(true);
    expect(secondResult.chunks).toBe(firstResult.chunks);
    expect(firstRebuildState.rowCount).toBe(firstResult.chunks);

    await fs.rm(hashPath, { force: true });
    const missingHashResult = await indexer.indexVault(vaultPath, false, workspacePath);
    const missingHashRebuildState = await readIndexState();

    expect(missingHashResult.success).toBe(true);
    expect(missingHashResult.chunks).toBe(firstResult.chunks);
    expect(missingHashRebuildState.rowCount).toBe(firstResult.chunks);
    expect(missingHashRebuildState.ftsIndex).toBeDefined();
  });

  it('keeps row count stable when incrementally reindexing a changed file', async () => {
    await fs.writeFile(
      path.join(vaultPath, 'first.md'),
      'This first note is long enough to be indexed and should stay present while another note changes.',
      'utf-8',
    );
    await fs.writeFile(
      path.join(vaultPath, 'second.md'),
      'This second note is long enough to be indexed before it changes during incremental indexing.',
      'utf-8',
    );

    const initialResult = await indexer.indexVault(vaultPath, true, workspacePath);

    await fs.writeFile(
      path.join(vaultPath, 'second.md'),
      'This second note changed, remains long enough to index, and should replace its old chunks incrementally.',
      'utf-8',
    );
    const incrementalResult = await indexer.indexVault(vaultPath, false, workspacePath);

    const lancedb = await import('@lancedb/lancedb');
    const vaultHash = md5(path.resolve(vaultPath));
    const dbPath = path.join(workspacePath, STORAGE_DIR_NAME, 'vaults', vaultHash, 'lancedb');

    const db = await lancedb.connect(dbPath);
    try {
      const table = await db.openTable('notes');
      const rowCount = await table.countRows();

      expect(initialResult.success).toBe(true);
      expect(initialResult.chunks).toBe(2);
      expect(incrementalResult.success).toBe(true);
      expect(incrementalResult.chunks).toBe(1);
      expect(rowCount).toBe(initialResult.chunks);
    } finally {
      if (typeof db.close === 'function') {
        db.close();
      }
    }
  });

  it('reports stale when a vault file changes after indexing', async () => {
    const notePath = path.join(vaultPath, 'note.md');
    await fs.writeFile(
      notePath,
      'This note is long enough to be indexed before an external Obsidian edit changes it.',
      'utf-8',
    );

    await indexer.indexVault(vaultPath, true, workspacePath);

    await expect(indexer.checkIndexStaleness(vaultPath, workspacePath)).resolves.toEqual({ stale: false });

    await fs.writeFile(
      notePath,
      'This note was changed outside the MCP write path and should make the index look stale.',
      'utf-8',
    );
    const future = new Date(Date.now() + 5000);
    await fs.utimes(notePath, future, future);

    await expect(indexer.checkIndexStaleness(vaultPath, workspacePath)).resolves.toEqual({
      stale: true,
      reason: 'vault files changed after the last index',
    });
  });

  it('records successful hashes when some files fail to embed so they retry next run', async () => {
    await fs.writeFile(
      path.join(vaultPath, 'ok.md'),
      'This note is long enough to embed successfully during a partially failing reindex.',
      'utf-8',
    );
    await fs.writeFile(
      path.join(vaultPath, 'bad.md'),
      'FAILEMBED this note is long enough to chunk but the embedder is rigged to reject it.',
      'utf-8',
    );

    const result = await indexer.indexVault(vaultPath, true, workspacePath);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to index 1 file(s)');

    // The hash file must reflect only the fully indexed files, so the failed
    // one is retried by the next incremental run instead of being masked.
    const hashPath = path.join(getVaultStorePath(), 'file-hashes.json');
    const hashes = JSON.parse(await fs.readFile(hashPath, 'utf-8'));
    expect(Object.keys(hashes)).toEqual(['ok.md']);

    // The freshness metadata is withheld, so queries keep warning.
    await expect(indexer.checkIndexStaleness(vaultPath, workspacePath)).resolves.toMatchObject({ stale: true });
  });

  it('does not replace rows or record a full hash when single-file indexing partially embeds', async () => {
    const relativePath = 'partial.md';
    const notePath = path.join(vaultPath, relativePath);
    const initialContent = [
      '# First',
      '',
      'This first paragraph is long enough to index successfully and mention amber.',
      '',
      '# Second',
      '',
      'This second paragraph is long enough to index successfully and mention cobalt.',
    ].join('\n');
    await fs.writeFile(notePath, initialContent, 'utf-8');
    const initialResult = await indexer.indexVault(vaultPath, true, workspacePath);
    expect(initialResult.success).toBe(true);
    expect(initialResult.chunks).toBe(2);

    const partialContent = [
      '# First',
      '',
      'This first paragraph changed and is still long enough to embed successfully.',
      '',
      '# Second',
      '',
      'FAILEMBED this second paragraph is long enough to chunk but fails embedding.',
    ].join('\n');
    await fs.writeFile(notePath, partialContent, 'utf-8');
    const result = await indexer.indexFile(vaultPath, relativePath, workspacePath);

    expect(result.success).toBe(false);
    expect(result.chunks).toBe(1);
    expect(result.message).toContain('1/2 chunks embedded');

    const hashPath = path.join(getVaultStorePath(), 'file-hashes.json');
    const hashes = JSON.parse(await fs.readFile(hashPath, 'utf-8'));
    expect(hashes[relativePath]).toBe(md5(initialContent));

    const lancedb = await import('@lancedb/lancedb');
    const dbPath = path.join(getVaultStorePath(), 'lancedb');
    const db = await lancedb.connect(dbPath);
    try {
      const table = await db.openTable('notes');
      expect(await table.countRows()).toBe(2);
    } finally {
      if (typeof db.close === 'function') {
        db.close();
      }
    }
  });

  it('keeps reporting stale after a single-file reindex when other files changed externally', async () => {
    const notePathA = path.join(vaultPath, 'a.md');
    const notePathB = path.join(vaultPath, 'b.md');
    await fs.writeFile(notePathA, 'This first note is long enough to be indexed and will be rewritten through MCP.', 'utf-8');
    await fs.writeFile(notePathB, 'This second note is long enough to be indexed and will change outside MCP.', 'utf-8');

    await indexer.indexVault(vaultPath, true, workspacePath);
    await expect(indexer.checkIndexStaleness(vaultPath, workspacePath)).resolves.toEqual({ stale: false });

    // External edit in Obsidian: content and mtime change without a reindex.
    await fs.writeFile(notePathB, 'This second note was edited outside the MCP write path and is not reindexed.', 'utf-8');
    const future = new Date(Date.now() + 5000);
    await fs.utimes(notePathB, future, future);

    // A write-tool reindex of a different note must not absorb b.md's edit.
    await indexer.indexFile(vaultPath, 'a.md', workspacePath);

    await expect(indexer.checkIndexStaleness(vaultPath, workspacePath)).resolves.toEqual({
      stale: true,
      reason: 'vault files changed after the last index',
    });
  });

  it('requires a forced full reindex when the schema version stamp is stale', async () => {
    await fs.writeFile(
      path.join(vaultPath, 'note.md'),
      'This note is long enough to be indexed and will survive an explicit schema migration.',
      'utf-8',
    );

    await indexer.indexVault(vaultPath, true, workspacePath);

    const lancedb = await import('@lancedb/lancedb');
    const vaultHash = md5(path.resolve(vaultPath));
    const storePath = path.join(workspacePath, STORAGE_DIR_NAME, 'vaults', vaultHash);
    const dbPath = path.join(storePath, 'lancedb');
    const schemaVersionPath = path.join(storePath, 'schema-version.json');
    await fs.writeFile(schemaVersionPath, JSON.stringify({ notesTableSchemaVersion: 1 }), 'utf-8');

    const result = await indexer.indexVault(vaultPath, false, workspacePath);

    expect(result.success).toBe(false);
    expect(result.message).toContain('force_reindex=true');

    // Reads must refuse too: serving rows shaped for another schema version
    // (or crashing on filters over old column types) would hide the migration.
    await expect(indexer.search('note', vaultPath, 5, workspacePath))
      .rejects.toThrow('force_reindex=true');

    const staleDb = await lancedb.connect(dbPath);
    try {
      const table = await staleDb.openTable('notes');
      expect(await table.countRows()).toBe(1);
    } finally {
      if (typeof staleDb.close === 'function') {
        staleDb.close();
      }
    }

    const forcedResult = await indexer.indexVault(vaultPath, true, workspacePath);
    expect(forcedResult.success).toBe(true);
    await expect(fs.readFile(schemaVersionPath, 'utf-8'))
      .resolves.toContain('"notesTableSchemaVersion":3');

    const verifyDb = await lancedb.connect(dbPath);
    try {
      const table = await verifyDb.openTable('notes');
      const schema = await table.schema();
      expect(schema.fields.some((f: any) => f.name === 'entities')).toBe(true);
      expect(schema.fields.some((f: any) => f.name === 'embedding_text')).toBe(true);
      expect(schema.fields.some((f: any) => f.name === 'heading_path')).toBe(true);
      expect(schema.fields.find((f: any) => f.name === 'entities')?.type.toString()).toBe('List<Utf8>');
      expect(schema.fields.find((f: any) => f.name === 'vector')?.type.toString()).toBe('FixedSizeList[384]<Float32>');
      expect(await table.countRows()).toBe(1);

      const indices = await table.listIndices() as Array<{ columns?: string[]; indexType?: string; type?: string }>;
      const ftsColumns = indices
        .filter((index) => (index.indexType ?? index.type) === 'FTS')
        .flatMap((index) => index.columns ?? []);
      expect(ftsColumns).toContain('embedding_text');
    } finally {
      if (typeof verifyDb.close === 'function') {
        verifyDb.close();
      }
    }
  });

  it('does not index markdown reached through an in-vault symlink pointing outside the vault', async () => {
    const outsideDir = path.join(tempDir, 'outside-index-target');
    await fs.mkdir(outsideDir);
    await fs.writeFile(
      path.join(vaultPath, 'inside.md'),
      'This inside note is long enough to be indexed and should be the only indexed vault content.',
      'utf-8',
    );
    await fs.writeFile(
      path.join(outsideDir, 'outside.md'),
      'This outside note is long enough to be indexed only when explicitly allowlisted.',
      'utf-8',
    );
    await fs.symlink(outsideDir, path.join(vaultPath, 'linked-outside'), 'dir');

    const result = await indexer.indexVault(vaultPath, true, workspacePath);

    expect(result.success).toBe(true);
    expect(result.chunks).toBe(1);
    const searchResults = await indexer.search('outside', vaultPath, 10, workspacePath);
    expect(searchResults.map((row: any) => row.path)).not.toContain('linked-outside/outside.md');
  });

  it('indexes symlinked markdown when the real target is in OBSIDIAN_ALLOWED_VAULTS', async () => {
    const outsideDir = path.join(tempDir, 'allowed-index-target');
    await fs.mkdir(outsideDir);
    process.env.OBSIDIAN_ALLOWED_VAULTS = [vaultPath, outsideDir].join(path.delimiter);
    await fs.writeFile(
      path.join(vaultPath, 'inside.md'),
      'This inside note is long enough to be indexed alongside an allowlisted linked folder.',
      'utf-8',
    );
    await fs.writeFile(
      path.join(outsideDir, 'outside.md'),
      'This outside note is long enough to be indexed because its real folder is allowlisted.',
      'utf-8',
    );
    await fs.symlink(outsideDir, path.join(vaultPath, 'linked-outside'), 'dir');

    const result = await indexer.indexVault(vaultPath, true, workspacePath);

    expect(result.success).toBe(true);
    expect(result.chunks).toBe(2);
  });

  it('creates an FTS index on the embedding_text column during indexing', async () => {
    await fs.writeFile(path.join(vaultPath, 'note.md'), 'This is a sufficiently long note to pass the minimum chunk size filter of forty characters.', 'utf-8');
    
    await indexer.indexVault(vaultPath, false, workspacePath);
    
    const lancedb = await import('@lancedb/lancedb');
    const vaultHash = md5(path.resolve(vaultPath));
    const dbPath = path.join(workspacePath, STORAGE_DIR_NAME, 'vaults', vaultHash, 'lancedb');
    
    const db = await lancedb.connect(dbPath);
    try {
      const table = await db.openTable('notes');
      const indices = await table.listIndices();
      
      const ftsIndex = indices.find((idx: any) => idx.indexType === 'FTS' && idx.columns.includes('embedding_text'));
      expect(ftsIndex).toBeDefined();
    } finally {
      if (typeof db.close === 'function') {
        db.close();
      }
    }
  });

  it('falls back to vectorSearch if fullTextSearch fails', async () => {
    await fs.writeFile(path.join(vaultPath, 'note.md'), 'This is a test note to trigger indexing with enough characters to pass the minimum filter.', 'utf-8');
    await indexer.indexVault(vaultPath, false, workspacePath);

    const simulatedError = new Error('Simulated FTS failure');

    const mockSearchBuilder = {
      fullTextSearch: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockRejectedValue(simulatedError)
    };

    const mockVectorBuilder = {
      select: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([{ path: 'fallback-note.md', text: 'vector fallback result' }])
    };

    const fakeTable = {
      search: vi.fn().mockReturnValue(mockSearchBuilder),
      vectorSearch: vi.fn().mockReturnValue(mockVectorBuilder)
    };

    // Inject the fake table at the public level of indexer by stubbing getTable
    vi.spyOn(indexer as any, 'getTable').mockResolvedValue(fakeTable);

    // Spy on the logger to assert the error-handling path runs
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Call the public search method
    const results = await indexer.search('test query', vaultPath, 5, workspacePath);

    // Assert that the hybrid search was attempted but failed, and fallback was used
    expect(fakeTable.search).toHaveBeenCalled();
    expect(mockSearchBuilder.fullTextSearch).toHaveBeenCalledWith('test query');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('FTS Hybrid Search failed'), simulatedError);
    expect(fakeTable.vectorSearch).toHaveBeenCalled();
    expect(results).toEqual([{ path: 'fallback-note.md', text: 'vector fallback result' }]);
  });

  it('moveFile removes stale source chunks and reindexes the destination path', async () => {
    const sourceRelativePath = 'old.md';
    const destRelativePath = 'archive/new.md';
    const sourcePath = path.join(vaultPath, sourceRelativePath);
    const destPath = path.join(vaultPath, destRelativePath);
    const content = 'This note is long enough to be indexed and contains a unique narwhal reference for search verification.';

    await fs.writeFile(sourcePath, content, 'utf-8');
    await indexer.indexVault(vaultPath, true, workspacePath);

    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.rename(sourcePath, destPath);

    const moveResult = await indexer.moveFile(
      vaultPath,
      sourceRelativePath,
      destRelativePath,
      workspacePath,
    );

    expect(moveResult.success).toBe(true);
    expect(moveResult.chunks).toBeGreaterThan(0);

    const searchResults = await indexer.search('narwhal', vaultPath, 10, workspacePath);
    const resultPaths = searchResults.map((result: any) => result.path);
    expect(resultPaths).toContain(destRelativePath);
    expect(resultPaths).not.toContain(sourceRelativePath);

    const vaultHash = md5(path.resolve(vaultPath));
    const hashPath = path.join(
      workspacePath,
      STORAGE_DIR_NAME,
      'vaults',
      vaultHash,
      'file-hashes.json',
    );
    const hashes = JSON.parse(await fs.readFile(hashPath, 'utf-8'));
    expect(hashes[sourceRelativePath]).toBeUndefined();
    expect(hashes[destRelativePath]).toBe(md5(content));
  });

  it('migrates an existing legacy storage root to the neutral storage root', async () => {
    await fs.writeFile(path.join(vaultPath, 'note.md'), 'This is a sufficiently long note to pass the minimum chunk size filter of forty characters.', 'utf-8');

    const legacyRoot = path.join(workspacePath, LEGACY_STORAGE_DIR_NAME);
    const markerPath = path.join(legacyRoot, 'vaults', 'legacy-marker', 'marker.txt');
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(markerPath, 'keep me', 'utf-8');

    await indexer.indexVault(vaultPath, false, workspacePath);

    await expect(fs.stat(path.join(workspacePath, LEGACY_STORAGE_DIR_NAME))).rejects.toThrow();
    await expect(fs.readFile(path.join(workspacePath, STORAGE_DIR_NAME, 'vaults', 'legacy-marker', 'marker.txt'), 'utf-8')).resolves.toBe('keep me');
  });
});
