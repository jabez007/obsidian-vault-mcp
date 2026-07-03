import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { LEGACY_STORAGE_DIR_NAME, STORAGE_DIR_NAME, VaultIndexer } from '../src/rag/store';
import md5 from 'md5';

// Mock the embedder to avoid loading real models during tests
vi.mock('../src/rag/embedder', () => ({
  Embedder: {
    getInstance: () => ({
      embed: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
      embedBatch: vi.fn().mockImplementation((texts: string[]) => 
        Promise.resolve(texts.map(() => new Array(384).fill(0.1)))
      ),
    })
  }
}));

// Global mock for os.homedir to allow control in tests
let mockHomedir: string | null = null;
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
  });

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

  it('creates an FTS index on the text column during indexing', async () => {
    await fs.writeFile(path.join(vaultPath, 'note.md'), 'This is a sufficiently long note to pass the minimum chunk size filter of forty characters.', 'utf-8');
    
    await indexer.indexVault(vaultPath, false, workspacePath);
    
    const lancedb = await import('@lancedb/lancedb');
    const vaultHash = md5(path.resolve(vaultPath));
    const dbPath = path.join(workspacePath, STORAGE_DIR_NAME, 'vaults', vaultHash, 'lancedb');
    
    const db = await lancedb.connect(dbPath);
    try {
      const table = await db.openTable('notes');
      const indices = await table.listIndices();
      
      const ftsIndex = indices.find((idx: any) => idx.indexType === 'FTS' && idx.columns.includes('text'));
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
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockRejectedValue(simulatedError)
    };

    const mockVectorBuilder = {
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
