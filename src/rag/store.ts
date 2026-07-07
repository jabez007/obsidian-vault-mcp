import * as lancedb from '@lancedb/lancedb';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { glob } from 'glob';
import matter from 'gray-matter';
import md5 from 'md5';
import { Embedder } from './embedder.js';
import { buildEmbeddingInputs, ChunkingOptions, normalizeToStringArray, NoteMetadata } from './chunking.js';
import { getSafeFilePath } from '../utils.js';

function getFirstNumericEnv(keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

function chunkingOptionsFromEnv(): ChunkingOptions {
  const minRaw = getFirstNumericEnv(['OBSIDIAN_MIN_CHUNK_CHARS', 'CODEX_OBSIDIAN_MIN_CHUNK_CHARS', 'GEMINI_OBSIDIAN_MIN_CHUNK_CHARS'], 40);
  const maxRaw = getFirstNumericEnv(['OBSIDIAN_MAX_CHUNK_CHARS', 'CODEX_OBSIDIAN_MAX_CHUNK_CHARS', 'GEMINI_OBSIDIAN_MAX_CHUNK_CHARS'], 1800);
  const targetRaw = getFirstNumericEnv(['OBSIDIAN_TARGET_CHUNK_CHARS', 'CODEX_OBSIDIAN_TARGET_CHUNK_CHARS', 'GEMINI_OBSIDIAN_TARGET_CHUNK_CHARS'], 700);
  const min = Number.isFinite(minRaw) && minRaw > 0 ? Math.floor(minRaw) : 40;
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : 1800;
  const target = Number.isFinite(targetRaw) && targetRaw > min ? Math.floor(targetRaw) : 700;
  return { minChunkChars: min, maxChunkChars: max, targetChunkChars: target };
}

interface NoteChunk extends NoteMetadata {
  vector: number[];
}

export const STORAGE_DIR_NAME = '.obsidian-vault-mcp';
export const LEGACY_STORAGE_DIR_NAME = '.gemini-obsidian';

export interface IndexResult {
  success: boolean;
  chunks?: number;
  message?: string;
}

export interface IndexStaleness {
  stale: boolean;
  reason?: string;
}

interface IndexLockInfo {
  pid?: number;
  createdAt?: number;
  token?: string;
  hostname?: string;
}

interface IndexMetadata {
  indexedAt: number;
  fileCount: number;
  latestMtimeMs: number;
}

const INDEX_LOCK_FILE_NAME = 'index.lock';
const INDEX_METADATA_FILE_NAME = 'index-metadata.json';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class VaultIndexer {
  private db: lancedb.Connection | null = null;
  private currentDbPath: string | null = null;
  private lock: Promise<void> = Promise.resolve();

  constructor() {}

  private async acquireLock(): Promise<() => void> {
    let release: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wait = this.lock;
    this.lock = nextLock;
    await wait;
    return release!;
  }

  public async reset() {
    const release = await this.acquireLock();
    try {
      this.db = null;
      this.currentDbPath = null;
    } finally {
      release();
    }
  }

  private validatePath(relativePath: string) {
    // Normalize path separators to forward slashes
    const normalized = relativePath.replace(/\\/g, '/');
    
    // Disallow path traversal (..)
    const segments = normalized.split('/');
    if (segments.some(s => s === '..')) {
      throw new Error(`Invalid file path (traversal): ${relativePath}`);
    }

    // Reject control characters and null bytes
    if (/[\x00-\x1F\x7F]/.test(normalized)) {
      throw new Error(`Invalid file path (control chars): ${relativePath}`);
    }

    return normalized;
  }

  private async getPaths(vaultPath: string, workspacePath?: string | null, vaultId?: string | null) {
    let vaultIdentifier: string;
    
    if (workspacePath) {
      if (!path.isAbsolute(workspacePath)) {
        throw new Error(`Invalid workspace_path: must be an absolute path. Received: ${workspacePath}`);
      }
      if (workspacePath.split(/[\\/]/).some(s => s === '..')) {
        throw new Error(`Invalid workspace_path: traversal segments are not allowed. Received: ${workspacePath}`);
      }
    }

    if (vaultId) {
      // Validate vaultId to prevent path traversal
      if (vaultId.includes('/') || vaultId.includes('\\') || vaultId.includes('..')) {
        throw new Error('Invalid vault_id: separators and traversal are not allowed');
      }
      vaultIdentifier = vaultId;
    } else {
      vaultIdentifier = md5(path.resolve(vaultPath));
    }

    const storageParent = workspacePath || os.homedir();
    const storageRoot = await this.getStorageRoot(storageParent);
    const baseStorePath = path.join(storageRoot, 'vaults', vaultIdentifier);

    const dbPath = path.join(baseStorePath, 'lancedb');
    const hashPath = path.join(baseStorePath, 'file-hashes.json');
    const lockPath = path.join(baseStorePath, INDEX_LOCK_FILE_NAME);
    const metadataPath = path.join(baseStorePath, INDEX_METADATA_FILE_NAME);

    // Ensure the storage directory exists
    await fs.mkdir(baseStorePath, { recursive: true });
    
    return { dbPath, hashPath, lockPath, metadataPath };
  }

  private async getStorageRoot(storageParent: string): Promise<string> {
    const newRoot = path.join(storageParent, STORAGE_DIR_NAME);
    const oldRoot = path.join(storageParent, LEGACY_STORAGE_DIR_NAME);
    const [newExists, oldExists] = await Promise.all([
      fs.stat(newRoot).then(() => true).catch(() => false),
      fs.stat(oldRoot).then(() => true).catch(() => false),
    ]);

    if (!newExists && oldExists) {
      try {
        await fs.rename(oldRoot, newRoot);
      } catch (error) {
        // A concurrent process (e.g. the session-init hook alongside the MCP
        // server) may have completed the migration between our existence
        // check and the rename. Only surface the error if the new root is
        // still missing.
        const migrated = await fs.stat(newRoot).then(() => true).catch(() => false);
        if (!migrated) throw error;
      }
    }

    return newRoot;
  }

  private async getDb(vaultPath: string, workspacePath?: string | null, vaultId?: string | null) {
    const { dbPath } = await this.getPaths(vaultPath, workspacePath, vaultId);
    if (this.db && this.currentDbPath === dbPath) {
      return this.db;
    }
    this.db = await lancedb.connect(dbPath);
    this.currentDbPath = dbPath;
    return this.db;
  }

  private async getTable(vaultPath: string, workspacePath?: string | null, vaultId?: string | null) {
    const db = await this.getDb(vaultPath, workspacePath, vaultId);
    const tableNames = await db.tableNames();
    if (tableNames.includes('notes')) {
      return await db.openTable('notes');
    }
    return null;
  }

  private async ensureFtsIndex(table: lancedb.Table) {
    try {
      const indices = await table.listIndices() as Array<{ columns?: string[]; indexType?: string; type?: string }>;
      const hasTextIndex = indices.some((index) => {
        const indexType = index.indexType ?? index.type;
        return indexType === 'FTS' && index.columns?.includes('text');
      });
      if (hasTextIndex) {
        console.error('FTS index already exists');
        return;
      }

      await table.createIndex('text', { config: lancedb.Index.fts() });
      console.error('created FTS index');
    } catch (error) {
      console.error('error ensuring FTS index', error);
    }
  }

  private async writeJsonAtomic(filePath: string, value: unknown) {
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(value), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  private async listMarkdownFiles(vaultPath: string): Promise<string[]> {
    return glob('**/*.md', { cwd: vaultPath, absolute: true, follow: true });
  }

  private filterIndexableMarkdownFiles(vaultPath: string, discoveredFiles: string[]): string[] {
    return discoveredFiles.filter((filePath) => {
      const relativePath = path.relative(vaultPath, filePath).replace(/\\/g, '/');
      try {
        getSafeFilePath(vaultPath, relativePath);
        return true;
      } catch (error: any) {
        console.error(`Skipping out-of-bounds indexed file ${relativePath}: ${error?.message ?? String(error)}`);
        return false;
      }
    });
  }

  // Freshness snapshots deliberately use the raw glob, not the
  // boundary-filtered list: the filter costs realpath syscalls per file and
  // adds no signal to a count/mtime heuristic, and both sides of the
  // staleness comparison must count the same set of files.
  private async getVaultIndexSnapshotForFiles(files: string[]): Promise<Omit<IndexMetadata, 'indexedAt'>> {
    const stats = await Promise.all(files.map((filePath) => fs.stat(filePath).catch(() => null)));
    const latestMtimeMs = stats.reduce((latest, stat) => {
      if (!stat) return latest;
      return Math.max(latest, stat.mtimeMs);
    }, 0);
    return {
      fileCount: files.length,
      latestMtimeMs,
    };
  }

  private async getVaultIndexSnapshot(vaultPath: string): Promise<Omit<IndexMetadata, 'indexedAt'>> {
    return this.getVaultIndexSnapshotForFiles(await this.listMarkdownFiles(vaultPath));
  }

  private async readIndexMetadata(metadataPath: string): Promise<IndexMetadata | null> {
    try {
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8')) as IndexMetadata;
      if (typeof metadata.fileCount !== 'number' || typeof metadata.latestMtimeMs !== 'number') {
        return null;
      }
      return metadata;
    } catch {
      return null;
    }
  }

  private async writeIndexMetadata(metadataPath: string, snapshot: Omit<IndexMetadata, 'indexedAt'>) {
    await this.writeJsonAtomic(metadataPath, {
      indexedAt: Date.now(),
      ...snapshot,
    });
  }

  // Merge a single indexed file into the freshness metadata. Only the file we
  // just indexed may advance the mtime watermark — recomputing it from a full
  // vault snapshot would absorb the mtimes of files edited outside MCP and
  // mask their staleness. The file count is recounted (one directory walk, no
  // stats) so our own note creations do not raise false stale notices; the
  // residual blind spot is an external deletion or timestamp-preserving sync
  // landing between full indexes, which the next indexVault reconciles.
  private async mergeIndexMetadataForFile(metadataPath: string, vaultPath: string, absoluteFilePath: string) {
    const previous = await this.readIndexMetadata(metadataPath);
    if (!previous) return; // stays missing until the next full index
    const [files, fileStat] = await Promise.all([
      this.listMarkdownFiles(vaultPath),
      fs.stat(absoluteFilePath).catch(() => null),
    ]);
    await this.writeIndexMetadata(metadataPath, {
      fileCount: files.length,
      latestMtimeMs: Math.max(previous.latestMtimeMs, fileStat?.mtimeMs ?? 0),
    });
  }

  private parseIndexLock(raw: string | null): IndexLockInfo | null {
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as IndexLockInfo;
    } catch {
      return null;
    }
  }

  private async readIndexLockRaw(lockPath: string): Promise<string | null> {
    try {
      return await fs.readFile(lockPath, 'utf-8');
    } catch {
      return null;
    }
  }

  private isPidRunning(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: any) {
      return error?.code === 'EPERM';
    }
  }

  private async isIndexLockStale(lockPath: string, raw: string, staleMs: number): Promise<boolean> {
    const stat = await fs.stat(lockPath).catch(() => null);
    if (!stat) return false; // lock vanished; the next open() attempt settles it
    const now = Date.now();
    const info = this.parseIndexLock(raw);
    if (!info) {
      // Content-less or corrupt lock: a live writer is only in this state for
      // the instant between creating the file and writing its info, so treat
      // it as stale after a short grace period instead of blocking indexing
      // for the full staleMs window.
      return now - stat.mtimeMs > 5000;
    }
    const createdAt = Number.isFinite(info.createdAt) ? Number(info.createdAt) : stat.mtimeMs;
    if (now - createdAt > staleMs) return true;
    // A pid recorded on another machine (shared or synced storage) says
    // nothing about a local process; only trust liveness for locks created
    // on this host and fall back to the age check otherwise.
    const sameHost = !info.hostname || info.hostname === os.hostname();
    if (sameHost && typeof info.pid === 'number' && !this.isPidRunning(info.pid)) return true;
    return false;
  }

  private async acquireIndexLock(lockPath: string): Promise<() => Promise<void>> {
    const waitMs = Math.max(0, getFirstNumericEnv(['OBSIDIAN_INDEX_LOCK_WAIT_MS', 'CODEX_OBSIDIAN_INDEX_LOCK_WAIT_MS', 'GEMINI_OBSIDIAN_INDEX_LOCK_WAIT_MS'], 30000));
    const staleMs = Math.max(0, getFirstNumericEnv(['OBSIDIAN_INDEX_LOCK_STALE_MS', 'CODEX_OBSIDIAN_INDEX_LOCK_STALE_MS', 'GEMINI_OBSIDIAN_INDEX_LOCK_STALE_MS'], 30 * 60 * 1000));
    const retryMs = Math.max(10, getFirstNumericEnv(['OBSIDIAN_INDEX_LOCK_RETRY_MS', 'CODEX_OBSIDIAN_INDEX_LOCK_RETRY_MS', 'GEMINI_OBSIDIAN_INDEX_LOCK_RETRY_MS'], 100));
    const startedAt = Date.now();
    const token = crypto.randomUUID();
    const lockInfo: IndexLockInfo = {
      pid: process.pid,
      createdAt: startedAt,
      token,
      hostname: os.hostname(),
    };

    while (true) {
      try {
        const handle = await fs.open(lockPath, 'wx');
        try {
          await handle.writeFile(JSON.stringify(lockInfo), 'utf-8');
        } finally {
          await handle.close();
        }

        let released = false;
        return async () => {
          if (released) return;
          released = true;
          const current = this.parseIndexLock(await this.readIndexLockRaw(lockPath));
          if (current?.token === token) {
            await fs.rm(lockPath, { force: true });
          }
        };
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
        const observedRaw = await this.readIndexLockRaw(lockPath);
        if (observedRaw === null) {
          // Lock vanished between open() and read; retry immediately.
          continue;
        }
        if (await this.isIndexLockStale(lockPath, observedRaw, staleMs)) {
          // Take over only while the lock is still byte-identical to the
          // stale one we judged: another waiter may have already taken over
          // and written its own lock, which a blind rm would destroy and
          // hand the lock to two holders at once.
          const currentRaw = await this.readIndexLockRaw(lockPath);
          if (currentRaw === observedRaw) {
            await fs.rm(lockPath, { force: true });
          }
          continue;
        }
        const elapsed = Date.now() - startedAt;
        if (elapsed >= waitMs) {
          throw new Error(`Timed out waiting for RAG index lock: ${lockPath}`);
        }
        await sleep(Math.min(retryMs, waitMs - elapsed));
      }
    }
  }

  private async deleteRowsForPaths(table: lancedb.Table, paths: string[]) {
    const uniquePaths = [...new Set(paths)];
    if (uniquePaths.length === 0) return;

    if (uniquePaths.length === 1) {
      await table.delete(`path = '${uniquePaths[0].replace(/'/g, "''")}'`);
      return;
    }

    const escaped = uniquePaths.map((p) => `'${p.replace(/'/g, "''")}'`);
    await table.delete(`path IN (${escaped.join(', ')})`);
  }

  private async embedWithFallback(
    embedder: Embedder,
    texts: string[],
    meta: NoteMetadata[]
  ): Promise<NoteChunk[]> {
    if (texts.length === 0) return [];

    try {
      const vectors = await embedder.embedBatch(texts);
      return meta.slice(0, vectors.length).map((item, idx) => ({
        ...item,
        vector: vectors[idx]
      }));
    } catch (batchErr) {
      console.error(`Failed to embed batch of ${texts.length} chunks; retrying one-by-one:`, batchErr);
    }

    const recovered: NoteChunk[] = [];
    for (let i = 0; i < texts.length; i++) {
      try {
        const vector = await embedder.embed(texts[i]);
        recovered.push({
          ...meta[i],
          vector
        });
      } catch (singleErr) {
        console.error(`Failed to embed chunk ${meta[i]?.id ?? i}:`, singleErr);
      }
    }
    return recovered;
  }

  public async indexFile(vaultPath: string, relativePath: string, workspacePath?: string | null, vaultId?: string | null): Promise<IndexResult> {
    const release = await this.acquireLock();
    let releaseIndexLock: (() => Promise<void>) | null = null;
    try {
      const normalizedPath = this.validatePath(relativePath);
      const { hashPath, lockPath, metadataPath } = await this.getPaths(vaultPath, workspacePath, vaultId);
      releaseIndexLock = await this.acquireIndexLock(lockPath);
      const embedder = Embedder.getInstance();
      const filePath = getSafeFilePath(vaultPath, relativePath);

      const content = await fs.readFile(filePath, 'utf-8');
      const contentHash = md5(content);
      const { content: body, data: metadata } = matter(content);

      const chunkingOptions = chunkingOptionsFromEnv();
      chunkingOptions.graphMetadata = {
        entities: normalizeToStringArray(metadata.entities),
        communities: normalizeToStringArray(metadata.communities)
      };

      const { textsToEmbed, chunkMetadata } = buildEmbeddingInputs(normalizedPath, body, chunkingOptions);

      // Load hashes to update
      let hashes: Record<string, string> = {};
      try {
          hashes = JSON.parse(await fs.readFile(hashPath, 'utf-8'));
      } catch { /* ignore */ }

      const db = await this.getDb(vaultPath, workspacePath, vaultId);
      const tableNames = await db.tableNames();

      if (textsToEmbed.length > 0) {
          const chunks = await this.embedWithFallback(embedder, textsToEmbed, chunkMetadata);
          if (chunks.length === 0) {
              return { success: false, message: `Failed to embed content for ${relativePath}.` };
          }
          const chunkRows = chunks as unknown as Record<string, unknown>[];

          let table: lancedb.Table;
          if (!tableNames.includes('notes')) {
              table = await db.createTable('notes', chunkRows);
              await this.ensureFtsIndex(table);
          } else {
              table = await db.openTable('notes');
              const schema = await table.schema();
              const hasEntities = schema.fields.some(f => f.name === 'entities');
              
              if (!hasEntities) {
                  console.error("Schema mismatch detected (missing 'entities'). Recreating table...");
                  await db.dropTable('notes');
                  table = await db.createTable('notes', chunkRows);
                  await this.ensureFtsIndex(table);
              } else {
                  await this.ensureFtsIndex(table);
                  // Delete old chunks for this file
                  await this.deleteRowsForPaths(table, [normalizedPath]);
                  await table.add(chunkRows);
              }
          }
          await table.optimize();
          
          hashes[normalizedPath] = contentHash;
          await this.writeJsonAtomic(hashPath, hashes);
          await this.mergeIndexMetadataForFile(metadataPath, vaultPath, filePath);
          console.error(`Indexed ${chunks.length} chunks for ${relativePath}.`);
          return { success: true, chunks: chunks.length };
      } else {
          // No chunks: Remove from DB and hashes
          if (tableNames.includes('notes')) {
              const table = await db.openTable('notes');
              await this.deleteRowsForPaths(table, [normalizedPath]);
              await table.optimize();
          }
          delete hashes[normalizedPath];
          await this.writeJsonAtomic(hashPath, hashes);
          await this.mergeIndexMetadataForFile(metadataPath, vaultPath, filePath);
          return { success: true, chunks: 0, message: "File removed from index (no embeddable content)." };
      }
    } catch (err) {
      console.error(`Failed to index file ${relativePath}:`, err);
      return { success: false, message: String(err) };
    } finally {
      if (releaseIndexLock) {
        await releaseIndexLock();
      }
      release();
    }
  }

  public async indexVault(vaultPath: string, force: boolean = false, workspacePath?: string | null, vaultId?: string | null): Promise<IndexResult> {
    const release = await this.acquireLock();
    let releaseIndexLock: (() => Promise<void>) | null = null;
    try {
      const { hashPath, lockPath, metadataPath } = await this.getPaths(vaultPath, workspacePath, vaultId);
      releaseIndexLock = await this.acquireIndexLock(lockPath);
      const embedder = Embedder.getInstance();
      const db = await this.getDb(vaultPath, workspacePath, vaultId);

      // Follow symlinked vault folders, but only index files whose real path
      // stays inside the vault boundary or an explicit OBSIDIAN_ALLOWED_VAULTS root.
      // The freshness snapshot uses the unfiltered list so it stays comparable
      // with checkIndexStaleness, which never applies the boundary filter.
      const discoveredFiles = await this.listMarkdownFiles(vaultPath);
      const files = this.filterIndexableMarkdownFiles(vaultPath, discoveredFiles);
      const indexStartSnapshot = await this.getVaultIndexSnapshotForFiles(discoveredFiles);
      console.error(`Found ${files.length} notes in ${vaultPath}`);

      // Load previous file hashes for incremental indexing
      let previousHashes: Record<string, string> = {};
      if (!force) {
        try {
          previousHashes = JSON.parse(await fs.readFile(hashPath, 'utf-8'));
        } catch { /* no previous hashes — will do full index */ }
      }

      const tableNames = await db.tableNames();
      const tableExists = tableNames.includes('notes');
      const hasPreviousHashes = Object.keys(previousHashes).length > 0;
      // Check schema compatibility up front so a legacy table (missing the
      // 'entities' column) downgrades to a full reindex before Phase 1 skips
      // unchanged files.
      let schemaCompatible = true;
      if (tableExists && hasPreviousHashes && !force) {
        const existingTable = await db.openTable('notes');
        const schema = await existingTable.schema();
        schemaCompatible = schema.fields.some(f => f.name === 'entities');
        if (!schemaCompatible) {
          console.error("Schema mismatch detected (missing 'entities'). Switching to full reindex.");
        }
      }
      const canIncremental = tableExists && hasPreviousHashes && !force && schemaCompatible;

      const batchSizeRaw = getFirstNumericEnv(['OBSIDIAN_EMBED_BATCH_SIZE', 'CODEX_OBSIDIAN_EMBED_BATCH_SIZE', 'GEMINI_OBSIDIAN_EMBED_BATCH_SIZE'], 48);
      const batchSize = Number.isFinite(batchSizeRaw) && batchSizeRaw > 0 ? Math.min(Math.floor(batchSizeRaw), 256) : 48;
      const useProgressBar = process.stderr.isTTY === true;
      const progressInterval = 100;

      // ── Phase 1: Read all files, compute hashes, build chunks for changed files ──
      const allTexts: string[] = [];
      const allMeta: NoteMetadata[] = [];
      const changedHashes: Record<string, string> = {}; // Hashes of files we are attempting to index
      const expectedChunkCounts: Record<string, number> = {}; // Expected total chunks per file
      const currentHashes: Record<string, string> = { ...previousHashes }; // Start with old hashes
      const changedPaths: string[] = [];
      let filesRead = 0;
      let skippedFiles = 0;

      const renderReadProgress = () => {
        if (files.length === 0) return;
        if (useProgressBar) {
          const percent = Math.min(100, Math.floor((filesRead / files.length) * 100));
          const width = 30;
          const filled = Math.round((percent / 100) * width);
          const bar = `${'='.repeat(filled)}${'-'.repeat(width - filled)}`;
          process.stderr.write(
            `\rReading [${bar}] ${percent}% ${filesRead}/${files.length} files`
          );
          if (filesRead === files.length) process.stderr.write('\n');
          return;
        }
        if (filesRead % progressInterval === 0 || filesRead === files.length) {
          console.error(`Reading progress: ${filesRead}/${files.length} files`);
        }
      };

      const FILE_READ_CONCURRENCY = 50;
      for (let i = 0; i < files.length; i += FILE_READ_CONCURRENCY) {
        const batch = files.slice(i, i + FILE_READ_CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (filePath) => {
            try {
              const content = await fs.readFile(filePath, 'utf-8');
              const relativePathRaw = path.relative(vaultPath, filePath);
              const relativePath = relativePathRaw.replace(/\\/g, '/');
              const contentHash = md5(content);

              // Skip unchanged files in incremental mode
              if (canIncremental && previousHashes[relativePath] === contentHash) {
                return null;
              }

              this.validatePath(relativePath);
              changedHashes[relativePath] = contentHash;
              changedPaths.push(relativePath);
              const { content: body, data: metadata } = matter(content);
              const chunkingOptions = chunkingOptionsFromEnv();
              chunkingOptions.graphMetadata = {
                entities: normalizeToStringArray(metadata.entities),
                communities: normalizeToStringArray(metadata.communities)
              };
              const inputs = buildEmbeddingInputs(relativePath, body, chunkingOptions);
              
              if (inputs.textsToEmbed.length > 0) {
                expectedChunkCounts[relativePath] = inputs.textsToEmbed.length;
                return inputs;
              } else {
                // File has no embeddable content (too short or empty)
                // Mark it as done immediately so we don't keep trying to index it
                currentHashes[relativePath] = contentHash;
                return null;
              }
            } catch (err) {
              console.error(`Failed to process file ${filePath}:`, err);
              return null;
            }
          })
        );

        for (const result of results) {
          if (result) {
            for (let j = 0; j < result.textsToEmbed.length; j++) {
              allTexts.push(result.textsToEmbed[j]);
              allMeta.push(result.chunkMetadata[j]);
            }
          } else {
            skippedFiles++;
          }
        }

        filesRead += batch.length;
        renderReadProgress();
      }

      // Determine deleted files (in previous hashes but not in current file set)
      const existingRelativePaths = new Set<string>();
      for (const f of files) {
          existingRelativePaths.add(path.relative(vaultPath, f).replace(/\\/g, '/'));
      }
      const deletedPaths = Object.keys(previousHashes).filter(p => !existingRelativePaths.has(p));

      if (canIncremental) {
        console.error(`Incremental: ${changedPaths.length} changed, ${deletedPaths.length} deleted, ${skippedFiles} unchanged`);
      } else {
        console.error(`Full index: ${allTexts.length} chunks from ${files.length} files`);
      }

      // Early exit: nothing changed
      if (canIncremental && allTexts.length === 0 && deletedPaths.length === 0) {
        console.error('Index is up to date, no changes detected.');
        await this.writeJsonAtomic(hashPath, currentHashes);
        await this.writeIndexMetadata(metadataPath, indexStartSnapshot);
        return { success: true, chunks: 0, message: 'Index up to date, no changes detected.' };
      }

      if (!canIncremental && allTexts.length === 0) {
        return { success: false, message: "No content found to index." };
      }

      // ── Phase 2: Update index ─────────────────────────────────────────

      let indexedChunks = 0;
      let tableInitialized = false;
      let table: lancedb.Table | null = null;
      const persistedChunkCounts: Record<string, number> = {};
      const resetTableOnFullReindex = !canIncremental && tableExists;

      // For incremental mode: delete old chunks for changed/deleted files, keep existing table
      if (canIncremental) {
        table = await db.openTable('notes');
        await this.ensureFtsIndex(table);

        const pathsToDelete = [...changedPaths, ...deletedPaths];
        if (pathsToDelete.length > 0) {
          const DELETE_BATCH = 100;
          for (let i = 0; i < pathsToDelete.length; i += DELETE_BATCH) {
            const batch = pathsToDelete.slice(i, i + DELETE_BATCH);
            await this.deleteRowsForPaths(table, batch);
          }
        }
        tableInitialized = true;
        for (const p of deletedPaths) delete currentHashes[p];
      } else {
          for (const k in currentHashes) delete currentHashes[k];
      }

      // Embed new/changed chunks (or all chunks for full reindex)
      if (allTexts.length > 0) {
        // Sort chunks by text length to reduce ONNX padding waste
        const sortedIndices = allTexts.map((_, i) => i);
        sortedIndices.sort((a, b) => allTexts[a].length - allTexts[b].length);
        const sortedTexts = sortedIndices.map(i => allTexts[i]);
        const sortedMeta = sortedIndices.map(i => allMeta[i]);

        let chunksEmbedded = 0;

        const renderEmbedProgress = () => {
          const total = sortedTexts.length;
          if (total === 0) return;
          if (useProgressBar) {
            const percent = Math.min(100, Math.floor((chunksEmbedded / total) * 100));
            const width = 30;
            const filled = Math.round((percent / 100) * width);
            const bar = `${'='.repeat(filled)}${'-'.repeat(width - filled)}`;
            process.stderr.write(
              `\rEmbedding [${bar}] ${percent}% ${chunksEmbedded}/${total} chunks`
            );
            if (chunksEmbedded === total) process.stderr.write('\n');
            return;
          }
          if (chunksEmbedded % (batchSize * 5) === 0 || chunksEmbedded === total) {
            console.error(`Embedding progress: ${chunksEmbedded}/${total} chunks`);
          }
        };

        const persistChunks = async (chunks: NoteChunk[]) => {
          if (chunks.length === 0) return;
          const chunkRows = chunks as unknown as Record<string, unknown>[];

          if (!tableInitialized) {
            // Only reachable on a full reindex: either no table exists yet, or
            // the stale one must be dropped before the first write.
            if (resetTableOnFullReindex) {
              await db.dropTable('notes');
            }
            table = await db.createTable('notes', chunkRows);
            await this.ensureFtsIndex(table);
            tableInitialized = true;
          } else {
            if (!table) {
              table = await db.openTable('notes');
            }
            await table.add(chunkRows);
          }

          indexedChunks += chunks.length;
          
          for (const c of chunks) {
              const p = c.path;
              persistedChunkCounts[p] = (persistedChunkCounts[p] || 0) + 1;
              if (persistedChunkCounts[p] === expectedChunkCounts[p]) {
                  if (changedHashes[p]) {
                      currentHashes[p] = changedHashes[p];
                  }
              }
          }
        };

        // Accumulate ~5 embedding batches before writing to reduce per-write overhead
        const WRITE_ACCUMULATE = 5;
        let pendingChunks: NoteChunk[] = [];
        let batchesSinceWrite = 0;
        let pendingWrite: Promise<void> | null = null;

        for (let i = 0; i < sortedTexts.length; i += batchSize) {
          const batchTexts = sortedTexts.slice(i, i + batchSize);
          const batchMeta = sortedMeta.slice(i, i + batchSize);

          const embeddedChunks = await this.embedWithFallback(embedder, batchTexts, batchMeta);
          pendingChunks.push(...embeddedChunks);
          batchesSinceWrite++;
          chunksEmbedded += batchTexts.length;
          renderEmbedProgress();

          if (batchesSinceWrite >= WRITE_ACCUMULATE) {
            if (pendingWrite) await pendingWrite;
            const chunksToWrite = pendingChunks;
            pendingChunks = [];
            batchesSinceWrite = 0;
            pendingWrite = persistChunks(chunksToWrite);
          }
        }

        if (pendingWrite) await pendingWrite;
        if (pendingChunks.length > 0) {
          await persistChunks(pendingChunks);
        }
      }

      // Compact fragments and clean up old versions to prevent stale references
      if (table) {
        await table.optimize();
      }

      // Save updated hashes
      await this.writeJsonAtomic(hashPath, currentHashes);
      await this.writeIndexMetadata(metadataPath, indexStartSnapshot);

      if (canIncremental) {
        console.error(`Incremental update: ${indexedChunks} chunks embedded, ${deletedPaths.length} files removed.`);
      } else {
        console.error(`Indexed ${indexedChunks} chunks.`);
      }
      return { success: true, chunks: indexedChunks };
    } finally {
      if (releaseIndexLock) {
        await releaseIndexLock();
      }
      release();
    }
  }

  public async moveFile(
    vaultPath: string,
    sourceRelativePath: string,
    destRelativePath: string,
    workspacePath?: string | null,
    vaultId?: string | null,
  ): Promise<IndexResult> {
    const release = await this.acquireLock();
    let releaseIndexLock: (() => Promise<void>) | null = null;
    try {
      const sourcePath = this.validatePath(sourceRelativePath);
      const destPath = this.validatePath(destRelativePath);
      const { hashPath, lockPath, metadataPath } = await this.getPaths(vaultPath, workspacePath, vaultId);
      releaseIndexLock = await this.acquireIndexLock(lockPath);
      const embedder = Embedder.getInstance();
      const filePath = getSafeFilePath(vaultPath, destRelativePath);

      const content = await fs.readFile(filePath, 'utf-8');
      const contentHash = md5(content);
      const { content: body, data: metadata } = matter(content);

      const chunkingOptions = chunkingOptionsFromEnv();
      chunkingOptions.graphMetadata = {
        entities: normalizeToStringArray(metadata.entities),
        communities: normalizeToStringArray(metadata.communities)
      };

      const { textsToEmbed, chunkMetadata } = buildEmbeddingInputs(destPath, body, chunkingOptions);
      const pathsToDelete = sourcePath === destPath ? [destPath] : [sourcePath, destPath];

      let hashes: Record<string, string> = {};
      try {
        hashes = JSON.parse(await fs.readFile(hashPath, 'utf-8'));
      } catch { /* ignore */ }

      const db = await this.getDb(vaultPath, workspacePath, vaultId);
      const tableNames = await db.tableNames();
      const hasTable = tableNames.includes('notes');

      if (textsToEmbed.length === 0) {
        if (hasTable) {
          const table = await db.openTable('notes');
          await this.deleteRowsForPaths(table, pathsToDelete);
          await table.optimize();
        }
        delete hashes[sourcePath];
        hashes[destPath] = contentHash;
        await this.writeJsonAtomic(hashPath, hashes);
        await this.mergeIndexMetadataForFile(metadataPath, vaultPath, filePath);
        return { success: true, chunks: 0, message: 'Moved file has no embeddable content.' };
      }

      const chunks = await this.embedWithFallback(embedder, textsToEmbed, chunkMetadata);
      if (chunks.length === 0) {
        return { success: false, message: `Failed to embed content for ${destRelativePath}.` };
      }

      const chunkRows = chunks as unknown as Record<string, unknown>[];
      let table: lancedb.Table;

      if (!hasTable) {
        table = await db.createTable('notes', chunkRows);
        await this.ensureFtsIndex(table);
      } else {
        table = await db.openTable('notes');
        const schema = await table.schema();
        const hasEntities = schema.fields.some(f => f.name === 'entities');

        if (!hasEntities) {
          console.error("Schema mismatch detected (missing 'entities'). Recreating table...");
          await db.dropTable('notes');
          table = await db.createTable('notes', chunkRows);
          await this.ensureFtsIndex(table);
        } else {
          await this.ensureFtsIndex(table);
          await this.deleteRowsForPaths(table, [destPath]);
          await table.add(chunkRows);
          if (sourcePath !== destPath) {
            await this.deleteRowsForPaths(table, [sourcePath]);
          }
        }
      }

      await table.optimize();
      delete hashes[sourcePath];
      hashes[destPath] = contentHash;
      await this.writeJsonAtomic(hashPath, hashes);
      await this.mergeIndexMetadataForFile(metadataPath, vaultPath, filePath);
      console.error(`Moved index entry from ${sourceRelativePath} to ${destRelativePath} (${chunks.length} chunks).`);
      return { success: true, chunks: chunks.length };
    } catch (err) {
      console.error(`Failed to move indexed file ${sourceRelativePath} to ${destRelativePath}:`, err);
      return { success: false, message: String(err) };
    } finally {
      if (releaseIndexLock) {
        await releaseIndexLock();
      }
      release();
    }
  }

  public async checkIndexStaleness(vaultPath: string, workspacePath?: string | null, vaultId?: string | null): Promise<IndexStaleness> {
    const { metadataPath } = await this.getPaths(vaultPath, workspacePath, vaultId);
    const metadata = await this.readIndexMetadata(metadataPath);
    if (!metadata) {
      return { stale: true, reason: 'index metadata is missing' };
    }

    const snapshot = await this.getVaultIndexSnapshot(vaultPath);
    if (snapshot.fileCount !== metadata.fileCount) {
      return {
        stale: true,
        reason: `vault file count changed (${metadata.fileCount} indexed, ${snapshot.fileCount} current)`,
      };
    }
    if (snapshot.latestMtimeMs > metadata.latestMtimeMs + 1) {
      return { stale: true, reason: 'vault files changed after the last index' };
    }
    // Restores that preserve both the file count and older timestamps (git
    // checkout, sync rollbacks) are invisible to this heuristic; a forced
    // obsidian_rag_index run is the recovery.
    return { stale: false };
  }

  public async search(query: string, vaultPath: string, limit: number = 5, workspacePath?: string | null, vaultId?: string | null) {
    const release = await this.acquireLock();
    try {
      const table = await this.getTable(vaultPath, workspacePath, vaultId);
      if (!table) {
          return [];
      }

      const embedder = Embedder.getInstance();
      const vector = await embedder.embed(query);

      try {
        const results = await table.search(vector)
            .fullTextSearch(query)
            .limit(limit)
            .toArray();
        return results;
      } catch (err) {
        console.error("FTS Hybrid Search failed, falling back to vector search. Consider running a full re-index.", err);
        const results = await table.vectorSearch(vector)
            .limit(limit)
            .toArray();
        return results;
      }
    } finally {
      release();
    }
  }
}
