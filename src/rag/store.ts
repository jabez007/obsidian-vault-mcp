import * as lancedb from '@lancedb/lancedb';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { Field, FixedSizeList, Float32, List, Schema, Utf8 } from 'apache-arrow';
import { glob } from 'glob';
import matter from 'gray-matter';
import md5 from 'md5';
import { Embedder } from './embedder.js';
import { buildEmbeddingInputs, ChunkingOptions, normalizeToStringArray, NoteMetadata } from './chunking.js';
import { getSafeFilePath } from '../utils.js';
import { prepareSnapshot, SnapshotResult } from './snapshot.js';

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
  maintenancePerformed?: boolean;
}

export interface IndexStaleness {
  stale: boolean;
  reason?: string;
}

export interface SearchFilters {
  entities?: string[];
  communities?: string[];
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
const SCHEMA_VERSION_FILE_NAME = 'schema-version.json';
const NOTES_TABLE_NAME = 'notes';
const NOTES_TABLE_SCHEMA_VERSION = 3;
const EMBEDDING_DIMENSIONS = 384;
const INDEX_RETENTION_DAYS = 7;
const FULL_REINDEX_REQUIRED_MESSAGE =
  'RAG index schema version changed. Run obsidian_rag_index with force_reindex=true to rebuild the local index.';
// Query results carry the clean text plus filterable metadata; embedding_text
// (the metadata-wrapped embedder input, also the FTS target) and the raw
// vector stay server-side.
const SEARCH_RESULT_COLUMNS = ['id', 'path', 'text', 'heading_path', 'entities', 'communities'];

const NOTES_TABLE_SCHEMA = new Schema([
  new Field('id', new Utf8(), false),
  new Field('path', new Utf8(), false),
  new Field('text', new Utf8(), false),
  new Field('embedding_text', new Utf8(), false),
  new Field('heading_path', new Utf8(), false),
  new Field('vector', new FixedSizeList(EMBEDDING_DIMENSIONS, new Field('item', new Float32(), false)), false),
  new Field('entities', new List(new Field('item', new Utf8(), true)), false),
  new Field('communities', new List(new Field('item', new Utf8(), true)), false),
]);

interface NotesSchemaVersionMetadata {
  notesTableSchemaVersion: number;
}

interface NoteIndexResult extends IndexResult {
  contentHash?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Match the vault scanner: lowercase markdown outside hidden directories.
function isIndexableNotePath(relativePath: string): boolean {
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, '/'));
  return normalized.endsWith('.md') && !normalized.split('/').some(segment => segment.startsWith('.'));
}

export class VaultIndexer {
  private db: lancedb.Connection | null = null;
  private currentDbPath: string | null = null;
  private lock: Promise<void> = Promise.resolve();

  constructor() {}

  private async acquireLock(waitMs?: number): Promise<() => void> {
    let release: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wait = this.lock;
    this.lock = nextLock;
    if (waitMs === undefined) {
      await wait;
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          wait,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Timed out waiting for the in-process RAG index lock. Retry after indexing finishes.')), waitMs);
          }),
        ]);
      } catch (error) {
        // Keep later waiters behind the current owner, but release this
        // abandoned queue entry as soon as that owner finishes.
        void wait.then(() => release());
        throw error;
      } finally { clearTimeout(timer); }
    }
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

    return path.posix.normalize(normalized);
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
    const schemaVersionPath = path.join(baseStorePath, SCHEMA_VERSION_FILE_NAME);

    // Ensure the storage directory exists
    getSafeFilePath(storageParent, path.relative(storageParent, baseStorePath));
    await fs.mkdir(baseStorePath, { recursive: true });
    
    return { dbPath, hashPath, lockPath, metadataPath, schemaVersionPath };
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
    if (tableNames.includes(NOTES_TABLE_NAME)) {
      return await db.openTable(NOTES_TABLE_NAME);
    }
    return null;
  }

  // FTS targets embedding_text, not the clean text column: entity/community
  // labels and heading breadcrumbs only exist in the metadata-wrapped copy,
  // and keyword search must keep matching them for graph-term queries.
  private async ensureFtsIndex(table: lancedb.Table) {
    try {
      const indices = await table.listIndices() as Array<{ columns?: string[]; indexType?: string; type?: string }>;
      const hasTextIndex = indices.some((index) => {
        const indexType = index.indexType ?? index.type;
        return indexType === 'FTS' && index.columns?.includes('embedding_text');
      });
      if (hasTextIndex) {
        console.error('FTS index already exists');
        return;
      }

      await table.createIndex('embedding_text', { config: lancedb.Index.fts() });
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

  private notesTableToArrow(chunks: NoteChunk[]) {
    return lancedb.makeArrowTable(chunks as unknown as Array<Record<string, unknown>>, {
      schema: NOTES_TABLE_SCHEMA,
    });
  }

  private async createNotesTable(db: lancedb.Connection, chunks: NoteChunk[] = []): Promise<lancedb.Table> {
    return db.createTable(NOTES_TABLE_NAME, this.notesTableToArrow(chunks));
  }

  private async addNoteChunks(table: lancedb.Table, chunks: NoteChunk[]) {
    if (chunks.length === 0) return;
    await table.add(this.notesTableToArrow(chunks));
  }

  private stringListColumnToArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string');
    }

    if (
      value &&
      typeof value === 'object' &&
      typeof (value as { length?: unknown }).length === 'number' &&
      typeof (value as { get?: unknown }).get === 'function'
    ) {
      const vector = value as { length: number; get(index: number): unknown };
      const result: string[] = [];
      for (let i = 0; i < vector.length; i++) {
        const item = vector.get(i);
        if (typeof item === 'string') result.push(item);
      }
      return result;
    }

    return [];
  }

  private normalizeSearchResults(rows: Array<Record<string, unknown>>) {
    return rows.map((row) => {
      const normalized = { ...row };
      if ('entities' in row) {
        normalized.entities = this.stringListColumnToArray(row.entities);
      }
      if ('communities' in row) {
        normalized.communities = this.stringListColumnToArray(row.communities);
      }
      return normalized;
    });
  }

  private escapeSqlString(value: string): string {
    return value.replace(/'/g, "''");
  }

  private buildArrayContainsPredicate(columnName: 'entities' | 'communities', values: string[]): string | null {
    const uniqueValues = [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
    if (uniqueValues.length === 0) return null;
    const predicates = uniqueValues.map((value) => `array_contains(${columnName}, '${this.escapeSqlString(value)}')`);
    return predicates.length === 1 ? predicates[0] : `(${predicates.join(' OR ')})`;
  }

  private buildSearchFilter(filters?: SearchFilters): string | null {
    const predicates = [
      this.buildArrayContainsPredicate('entities', filters?.entities ?? []),
      this.buildArrayContainsPredicate('communities', filters?.communities ?? []),
    ].filter((predicate): predicate is string => Boolean(predicate));

    return predicates.length > 0 ? predicates.join(' AND ') : null;
  }

  private async readNotesSchemaVersion(schemaVersionPath: string): Promise<number | null> {
    try {
      const metadata = JSON.parse(await fs.readFile(schemaVersionPath, 'utf-8')) as Partial<NotesSchemaVersionMetadata>;
      return typeof metadata.notesTableSchemaVersion === 'number'
        ? metadata.notesTableSchemaVersion
        : null;
    } catch {
      return null;
    }
  }

  private async writeNotesSchemaVersion(schemaVersionPath: string) {
    await this.writeJsonAtomic(schemaVersionPath, {
      notesTableSchemaVersion: NOTES_TABLE_SCHEMA_VERSION,
    } satisfies NotesSchemaVersionMetadata);
  }

  private async existingNotesTableRequiresReindex(db: lancedb.Connection, schemaVersionPath: string): Promise<boolean> {
    const tableNames = await db.tableNames();
    if (!tableNames.includes(NOTES_TABLE_NAME)) return false;
    return (await this.readNotesSchemaVersion(schemaVersionPath)) !== NOTES_TABLE_SCHEMA_VERSION;
  }

  private fullReindexRequiredResult(): IndexResult {
    return { success: false, message: FULL_REINDEX_REQUIRED_MESSAGE };
  }

  private async listMarkdownFiles(vaultPath: string): Promise<string[]> {
    const files = await glob('**/*.md', { cwd: vaultPath, absolute: true, follow: true, dot: false, nocase: false, nodir: true });
    return files.filter(file => isIndexableNotePath(path.relative(vaultPath, file)));
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
  private async mergeIndexMetadataForFile(metadataPath: string, vaultPath: string, absoluteFilePath: string | null) {
    const previous = await this.readIndexMetadata(metadataPath);
    if (!previous) return; // stays missing until the next full index
    const [files, fileStat] = await Promise.all([
      this.listMarkdownFiles(vaultPath),
      absoluteFilePath ? fs.stat(absoluteFilePath).catch(() => null) : null,
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
    // A pid recorded on another machine (shared or synced storage) says
    // nothing about a local process; only trust liveness for locks created
    // on this host. Age is only a fallback for legacy locks without a PID.
    const sameHost = !info.hostname || info.hostname === os.hostname();
    if (sameHost && typeof info.pid === 'number') return !this.isPidRunning(info.pid);
    // Never steal a remote host's lock: age cannot prove that its owner died.
    if (!sameHost) return false;
    return now - createdAt > staleMs;
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
      await table.delete(`path = '${this.escapeSqlString(uniquePaths[0])}'`);
      return;
    }

    const escaped = uniquePaths.map((p) => `'${this.escapeSqlString(p)}'`);
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

  private prepareNoteChunks(relativePath: string, content: string): {
    contentHash: string;
    textsToEmbed: string[];
    chunkMetadata: NoteMetadata[];
  } {
    const contentHash = md5(content);
    const { content: body, data: metadata } = matter(content);

    const chunkingOptions = chunkingOptionsFromEnv();
    chunkingOptions.graphMetadata = {
      entities: normalizeToStringArray(metadata.entities),
      communities: normalizeToStringArray(metadata.communities),
    };

    const { textsToEmbed, chunkMetadata } = buildEmbeddingInputs(relativePath, body, chunkingOptions);
    return { contentHash, textsToEmbed, chunkMetadata };
  }

  private async indexNoteIntoTable(
    table: lancedb.Table,
    embedder: Embedder,
    vaultPath: string,
    relativePath: string,
    pathsToDelete?: string[],
  ): Promise<NoteIndexResult> {
    const normalizedPath = this.validatePath(relativePath);
    const filePath = getSafeFilePath(vaultPath, normalizedPath);
    const content = await fs.readFile(filePath, 'utf-8');
    const { contentHash, textsToEmbed, chunkMetadata } = this.prepareNoteChunks(normalizedPath, content);
    const deleteTargets = pathsToDelete ?? [normalizedPath];

    if (textsToEmbed.length === 0) {
      await this.deleteRowsForPaths(table, deleteTargets);
      return {
        success: true,
        chunks: 0,
        contentHash,
        message: 'File removed from index (no embeddable content).',
      };
    }

    const chunks = await this.embedWithFallback(embedder, textsToEmbed, chunkMetadata);
    if (chunks.length === 0) {
      return { success: false, contentHash, message: `Failed to embed content for ${relativePath}.` };
    }
    if (chunks.length < textsToEmbed.length) {
      return {
        success: false,
        chunks: chunks.length,
        message: `Failed to embed all content for ${relativePath}: ${chunks.length}/${textsToEmbed.length} chunks embedded.`,
      };
    }

    await this.deleteRowsForPaths(table, deleteTargets);
    await this.addNoteChunks(table, chunks);
    return { success: true, chunks: chunks.length, contentHash };
  }

  // Called with both locks held. Skipped writes can clean old pollution without
  // creating a database or loading the embedding model.
  private async removeExcludedPaths(
    vaultPath: string, paths: string[], workspacePath?: string | null, vaultId?: string | null,
  ): Promise<IndexResult> {
    const { dbPath, hashPath, schemaVersionPath } = await this.getPaths(vaultPath, workspacePath, vaultId);
    const exists = await fs.stat(dbPath).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (exists) {
      const db = await this.getDb(vaultPath, workspacePath, vaultId);
      if (await this.existingNotesTableRequiresReindex(db, schemaVersionPath)) return this.fullReindexRequiredResult();
      if ((await db.tableNames()).includes(NOTES_TABLE_NAME)) {
        const table = await db.openTable(NOTES_TABLE_NAME);
        try { await this.deleteRowsForPaths(table, paths); } finally { table.close(); }
      }
    }
    let hashes: Record<string, string>;
    try {
      hashes = JSON.parse(await fs.readFile(hashPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { success: true, chunks: 0, message: 'File excluded from the markdown index.' };
      }
      throw error;
    }
    for (const p of paths) delete hashes[p];
    await this.writeJsonAtomic(hashPath, hashes);
    return { success: true, chunks: 0, message: 'File excluded from the markdown index.' };
  }

  public async indexFile(vaultPath: string, relativePath: string, workspacePath?: string | null, vaultId?: string | null): Promise<IndexResult> {
    const release = await this.acquireLock();
    let releaseIndexLock: (() => Promise<void>) | null = null;
    try {
      const normalizedPath = this.validatePath(relativePath);
      const filePath = getSafeFilePath(vaultPath, normalizedPath);
      const { hashPath, lockPath, metadataPath, schemaVersionPath } = await this.getPaths(vaultPath, workspacePath, vaultId);
      releaseIndexLock = await this.acquireIndexLock(lockPath);
      if (!isIndexableNotePath(normalizedPath)) {
        return await this.removeExcludedPaths(vaultPath, [normalizedPath], workspacePath, vaultId);
      }
      const embedder = Embedder.getInstance();
      const db = await this.getDb(vaultPath, workspacePath, vaultId);
      const tableNames = await db.tableNames();

      if (await this.existingNotesTableRequiresReindex(db, schemaVersionPath)) {
        return this.fullReindexRequiredResult();
      }

      // Load hashes to update
      let hashes: Record<string, string> = {};
      try {
          hashes = JSON.parse(await fs.readFile(hashPath, 'utf-8'));
      } catch { /* ignore */ }

      const table = tableNames.includes(NOTES_TABLE_NAME)
        ? await db.openTable(NOTES_TABLE_NAME)
        : await this.createNotesTable(db);
      if (!tableNames.includes(NOTES_TABLE_NAME)) {
        await this.writeNotesSchemaVersion(schemaVersionPath);
      }
      await this.ensureFtsIndex(table);

      const result = await this.indexNoteIntoTable(table, embedder, vaultPath, normalizedPath);
      if (!result.success) return result;

      if (result.chunks && result.chunks > 0) {
        hashes[normalizedPath] = result.contentHash!;
        console.error(`Indexed ${result.chunks} chunks for ${relativePath}.`);
      } else {
        delete hashes[normalizedPath];
      }
      await this.writeJsonAtomic(hashPath, hashes);
      await this.mergeIndexMetadataForFile(metadataPath, vaultPath, filePath);
      return { success: true, chunks: result.chunks, message: result.message };
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

  // Call only while holding the in-process and per-vault index locks.
  private async maintainTable(table: lancedb.Table): Promise<void> {
    await table.optimize({
      cleanupOlderThan: new Date(Date.now() - INDEX_RETENTION_DAYS * 86400000),
      deleteUnverified: false,
    });
  }

  public async indexVault(vaultPath: string, force: boolean = false, workspacePath?: string | null, vaultId?: string | null, maintenance: boolean = false): Promise<IndexResult> {
    const release = await this.acquireLock();
    let releaseIndexLock: (() => Promise<void>) | null = null;
    try {
      const { hashPath, lockPath, metadataPath, schemaVersionPath } = await this.getPaths(vaultPath, workspacePath, vaultId);
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
      let hasHashFile = false;
      if (!force) {
        try {
          previousHashes = JSON.parse(await fs.readFile(hashPath, 'utf-8'));
          hasHashFile = true;
        } catch { /* no previous hashes — will do full index */ }
      }

      const tableNames = await db.tableNames();
      const tableExists = tableNames.includes(NOTES_TABLE_NAME);
      if (tableExists && !force && await this.existingNotesTableRequiresReindex(db, schemaVersionPath)) {
        return this.fullReindexRequiredResult();
      }
      // An empty hash map is valid for an empty vault. Rebuilding it on every
      // session start would also run unnecessary maintenance each time.
      const canIncremental = tableExists && hasHashFile && !force;
      const currentHashes: Record<string, string> = canIncremental ? { ...previousHashes } : {};

      // Determine deleted files (in previous hashes but not in current file set)
      const existingRelativePaths = new Set<string>();
      for (const f of files) {
          existingRelativePaths.add(path.relative(vaultPath, f).replace(/\\/g, '/'));
      }
      const deletedPaths = canIncremental
        ? Object.keys(previousHashes).filter(p => !existingRelativePaths.has(p))
        : [];

      let table: lancedb.Table;
      if (canIncremental) {
        table = await db.openTable(NOTES_TABLE_NAME);
      } else {
        if (tableExists) {
          await db.dropTable(NOTES_TABLE_NAME);
        }
        table = await this.createNotesTable(db);
        await this.writeNotesSchemaVersion(schemaVersionPath);
      }

      const batchSizeRaw = getFirstNumericEnv(['OBSIDIAN_EMBED_BATCH_SIZE', 'CODEX_OBSIDIAN_EMBED_BATCH_SIZE', 'GEMINI_OBSIDIAN_EMBED_BATCH_SIZE'], 48);
      const batchSize = Number.isFinite(batchSizeRaw) && batchSizeRaw > 0 ? Math.min(Math.floor(batchSizeRaw), 256) : 48;
      const useProgressBar = process.stderr.isTTY === true;
      const progressInterval = 100;

      // ── Phase 1: read files concurrently, hash, chunk the changed ones ──
      const allTexts: string[] = [];
      const allMeta: NoteMetadata[] = [];
      const changedHashes: Record<string, string> = {};
      const expectedChunkCounts: Record<string, number> = {};
      const changedPaths: string[] = [];
      let filesRead = 0;
      let skippedFiles = 0;
      let failedFiles = 0;

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
              const relativePath = this.validatePath(path.relative(vaultPath, filePath).replace(/\\/g, '/'));
              const contentHash = md5(content);

              if (canIncremental && previousHashes[relativePath] === contentHash) {
                return 'skipped' as const;
              }

              const inputs = this.prepareNoteChunks(relativePath, content);
              changedHashes[relativePath] = contentHash;
              changedPaths.push(relativePath);
              if (inputs.textsToEmbed.length > 0) {
                expectedChunkCounts[relativePath] = inputs.textsToEmbed.length;
                return inputs;
              }
              // No embeddable content: nothing to add, and the incremental
              // delete pass below removes any stale rows. Record the hash
              // immediately so we do not keep reprocessing the file.
              currentHashes[relativePath] = inputs.contentHash;
              return 'empty' as const;
            } catch (err) {
              console.error(`Failed to process file ${filePath}:`, err);
              return 'failed' as const;
            }
          })
        );

        for (const result of results) {
          if (result === 'skipped') {
            skippedFiles++;
          } else if (result === 'failed') {
            failedFiles++;
          } else if (result !== 'empty') {
            for (let j = 0; j < result.textsToEmbed.length; j++) {
              allTexts.push(result.textsToEmbed[j]);
              allMeta.push(result.chunkMetadata[j]);
            }
          }
        }

        filesRead += batch.length;
        renderReadProgress();
      }

      if (canIncremental) {
        console.error(`Incremental: ${changedPaths.length} changed, ${deletedPaths.length} deleted, ${skippedFiles} unchanged`);
      } else {
        console.error(`Full index: ${allTexts.length} chunks from ${files.length} files`);
      }

      // Incremental: remove old rows for changed/deleted files. A full
      // reindex starts from a freshly created table, so nothing to delete.
      if (canIncremental) {
        const pathsToDelete = [...changedPaths, ...deletedPaths];
        const DELETE_BATCH = 100;
        for (let i = 0; i < pathsToDelete.length; i += DELETE_BATCH) {
          await this.deleteRowsForPaths(table, pathsToDelete.slice(i, i + DELETE_BATCH));
        }
        for (const p of deletedPaths) delete currentHashes[p];
      }

      // ── Phase 2: embed changed chunks in length-sorted batches ──
      let indexedChunks = 0;
      const persistedChunkCounts: Record<string, number> = {};

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
          await this.addNoteChunks(table, chunks);
          indexedChunks += chunks.length;

          // A file's hash is recorded only once every one of its chunks has
          // been persisted, so partially indexed files are retried next run.
          for (const c of chunks) {
            const p = c.path;
            persistedChunkCounts[p] = (persistedChunkCounts[p] || 0) + 1;
            if (persistedChunkCounts[p] === expectedChunkCounts[p] && changedHashes[p]) {
              currentHashes[p] = changedHashes[p];
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

      // Files whose chunks did not all persist (embedding failures) count as
      // failed; their hashes were never recorded, so the next run retries them.
      for (const p of Object.keys(expectedChunkCounts)) {
        if (persistedChunkCounts[p] !== expectedChunkCounts[p]) failedFiles++;
      }

      // Ensure the FTS index after rows exist rather than only against the
      // empty just-created table, so a failed creation is retried here.
      await this.ensureFtsIndex(table);

      if (canIncremental && changedPaths.length === 0 && deletedPaths.length === 0 && failedFiles === 0) {
        console.error('Index is up to date, no changes detected.');
        if (maintenance) await this.maintainTable(table);
        await this.writeJsonAtomic(hashPath, currentHashes);
        await this.writeIndexMetadata(metadataPath, indexStartSnapshot);
        return { success: true, chunks: 0, message: maintenance ? 'Index up to date. Maintenance completed.' : 'Index up to date, no changes detected.', maintenancePerformed: maintenance };
      }

      await this.maintainTable(table);

      // Always persist the hashes: they contain exactly the files that were
      // fully indexed, so failed files are retried on the next run instead of
      // being masked by their pre-failure hashes.
      await this.writeJsonAtomic(hashPath, currentHashes);

      if (failedFiles > 0) {
        // Skip the freshness metadata so queries keep warning that the index
        // is stale until a run completes without failures.
        return {
          success: false,
          chunks: indexedChunks,
          message: `Failed to index ${failedFiles} file(s).`,
        };
      }

      await this.writeIndexMetadata(metadataPath, indexStartSnapshot);

      if (canIncremental) {
        console.error(`Incremental update: ${indexedChunks} chunks embedded, ${deletedPaths.length} files removed.`);
      } else {
        console.error(`Indexed ${indexedChunks} chunks.`);
      }
      return { success: true, chunks: indexedChunks, maintenancePerformed: true };
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
      getSafeFilePath(vaultPath, sourcePath);
      const filePath = getSafeFilePath(vaultPath, destPath);
      const pathsToDelete = sourcePath === destPath ? [destPath] : [sourcePath, destPath];
      const { hashPath, lockPath, metadataPath, schemaVersionPath } = await this.getPaths(vaultPath, workspacePath, vaultId);
      releaseIndexLock = await this.acquireIndexLock(lockPath);
      if (!isIndexableNotePath(destPath)) {
        const result = await this.removeExcludedPaths(vaultPath, pathsToDelete, workspacePath, vaultId);
        if (result.success && isIndexableNotePath(sourcePath)) {
          await this.mergeIndexMetadataForFile(metadataPath, vaultPath, null);
        }
        return result;
      }
      const embedder = Embedder.getInstance();
      const db = await this.getDb(vaultPath, workspacePath, vaultId);
      const tableNames = await db.tableNames();

      if (await this.existingNotesTableRequiresReindex(db, schemaVersionPath)) {
        return this.fullReindexRequiredResult();
      }

      let hashes: Record<string, string> = {};
      try {
        hashes = JSON.parse(await fs.readFile(hashPath, 'utf-8'));
      } catch { /* ignore */ }

      const table = tableNames.includes(NOTES_TABLE_NAME)
        ? await db.openTable(NOTES_TABLE_NAME)
        : await this.createNotesTable(db);
      if (!tableNames.includes(NOTES_TABLE_NAME)) {
        await this.writeNotesSchemaVersion(schemaVersionPath);
      }
      await this.ensureFtsIndex(table);

      const result = await this.indexNoteIntoTable(table, embedder, vaultPath, destPath, pathsToDelete);
      if (!result.success) return result;

      delete hashes[sourcePath];
      if (result.contentHash) {
        hashes[destPath] = result.contentHash;
      }
      await this.writeJsonAtomic(hashPath, hashes);
      await this.mergeIndexMetadataForFile(metadataPath, vaultPath, filePath);

      if ((result.chunks ?? 0) === 0) {
        return { success: true, chunks: 0, message: 'Moved file has no embeddable content.' };
      }

      console.error(`Moved index entry from ${sourceRelativePath} to ${destRelativePath} (${result.chunks} chunks).`);
      return { success: true, chunks: result.chunks };
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

  public async prepareIndexSnapshot(vaultPath: string, workspacePath?: string | null, vaultId?: string | null): Promise<SnapshotResult> {
    const waitMs = Math.max(0, getFirstNumericEnv(['OBSIDIAN_INDEX_LOCK_WAIT_MS', 'CODEX_OBSIDIAN_INDEX_LOCK_WAIT_MS', 'GEMINI_OBSIDIAN_INDEX_LOCK_WAIT_MS'], 30000));
    const release = await this.acquireLock(waitMs);
    let releaseIndexLock: (() => Promise<void>) | undefined;
    try {
      const paths = await this.getPaths(vaultPath, workspacePath, vaultId);
      const basePath = path.dirname(paths.dbPath);
      releaseIndexLock = await this.acquireIndexLock(paths.lockPath);
      return await prepareSnapshot(basePath, NOTES_TABLE_SCHEMA, NOTES_TABLE_SCHEMA_VERSION, async (hashes) => {
        const files = this.filterIndexableMarkdownFiles(vaultPath, await this.listMarkdownFiles(vaultPath));
        if (files.length !== Object.keys(hashes).length) {
          throw new Error('Index is stale: note membership changed. Run obsidian_rag_index before preparing a snapshot.');
        }
        for (const file of files) {
          const relative = path.relative(vaultPath, file).replace(/\\/g, '/');
          const content = await fs.readFile(getSafeFilePath(vaultPath, relative), 'utf8');
          if (hashes[relative] !== md5(content)) {
            throw new Error(`Index is stale: ${relative} changed. Run obsidian_rag_index before preparing a snapshot.`);
          }
        }
      });
    } finally {
      try { await releaseIndexLock?.(); } finally { release(); }
    }
  }

  public async search(
    query: string,
    vaultPath: string,
    limit: number = 5,
    workspacePath?: string | null,
    vaultId?: string | null,
    filters?: SearchFilters,
  ) {
    const release = await this.acquireLock();
    try {
      // Refuse to read an index built for another schema version, matching
      // the write paths: silently serving old-shaped rows (or raw engine
      // errors from filters on old column types) hides the needed migration.
      const { schemaVersionPath } = await this.getPaths(vaultPath, workspacePath, vaultId);
      const db = await this.getDb(vaultPath, workspacePath, vaultId);
      if (await this.existingNotesTableRequiresReindex(db, schemaVersionPath)) {
        throw new Error(FULL_REINDEX_REQUIRED_MESSAGE);
      }

      const table = await this.getTable(vaultPath, workspacePath, vaultId);
      if (!table) {
          return [];
      }

      const embedder = Embedder.getInstance();
      const vector = await embedder.embed(query);
      const filterPredicate = this.buildSearchFilter(filters);

      const runSearch = async (search: {
        where(predicate: string): unknown;
        select(columns: string[]): unknown;
        limit(limit: number): unknown;
        toArray(): Promise<unknown[]>;
      }) => {
        if (filterPredicate) search.where(filterPredicate);
        search.select(SEARCH_RESULT_COLUMNS);
        search.limit(limit);
        const results = await search.toArray();
        return this.normalizeSearchResults(results as Array<Record<string, unknown>>);
      };

      try {
        return await runSearch(table.search(vector).fullTextSearch(query));
      } catch (err) {
        console.error("FTS Hybrid Search failed, falling back to vector search. Consider running a full re-index.", err);
        return await runSearch(table.vectorSearch(vector));
      }
    } finally {
      release();
    }
  }
}
