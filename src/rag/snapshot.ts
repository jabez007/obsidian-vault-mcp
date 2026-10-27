import * as fs from 'node:fs/promises';
import { createReadStream, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as lancedb from '@lancedb/lancedb';
import type { Schema } from 'apache-arrow';
import { NotePolicy } from '../note-policy.js';
import { assertLocalManifest } from './local-manifest.js';

const POLICY_VERSION = 3;
const COMPANION_FILES = ['file-hashes.json', 'schema-version.json', 'index-metadata.json'];
const PAYLOAD_ENTRIES = ['lancedb', ...COMPANION_FILES];
const MANIFEST_FILE = 'snapshot.json';
const ENGINE_VERSION: string = JSON.parse(readFileSync(path.join(path.dirname(require.resolve('@lancedb/lancedb')), '..', 'package.json'), 'utf8')).version;

type Inventory = Array<{ path: string; bytes: number; sha256: string }>;
type Size = { bytes: number; files: number };

export interface SnapshotResult {
  success: true;
  snapshotPath: string;
  rulesFingerprint: string;
  sourceFingerprint: string;
  sourceVersion: number;
  reused: boolean;
  before: Size;
  after: Size;
  versionsBefore: number[];
  versionsRetained: number[];
  versionsRemoved: number[];
  retention: { olderThan: string; deleteUnverified: true };
  compaction: 'once-per-source-state';
  validation: { rows: number; contentSha256: string; vectorQuery: boolean; fullTextQuery: boolean };
  compatibility: { notesTableSchemaVersion: number; lanceDbVersion: string };
}

interface SnapshotManifest {
  policyVersion: number;
  rulesFingerprint: string;
  files: Inventory;
  result: SnapshotResult;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function totals(files: Inventory): Size {
  return { bytes: files.reduce((sum, file) => sum + file.bytes, 0), files: files.length };
}

async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function inventory(root: string, entries?: string[]): Promise<Inventory> {
  const files: Inventory = [];
  async function visit(relative: string) {
    const absolute = path.join(root, relative);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Snapshot paths must not contain symbolic links: ${absolute}`);
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(absolute)) await visit(path.join(relative, entry));
    } else if (stat.isFile()) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(absolute)) hash.update(chunk);
      files.push({ path: relative.split(path.sep).join('/'), bytes: stat.size, sha256: hash.digest('hex') });
    } else {
      throw new Error(`Unsupported snapshot file type: ${absolute}`);
    }
  }
  for (const entry of entries ?? await fs.readdir(root)) await visit(entry);
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function sameInventory(a: Inventory, b: Inventory): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function readMetadata(basePath: string, schemaVersion: number) {
  const [hashes, schema, metadata] = await Promise.all(COMPANION_FILES.map(async file =>
    JSON.parse(await fs.readFile(path.join(basePath, file), 'utf8'))));
  if (schema?.notesTableSchemaVersion !== schemaVersion) {
    throw new Error('Incompatible index schema. Run obsidian_rag_index with force_reindex=true before preparing a snapshot.');
  }
  if ((metadata?.pendingPaths?.length ?? 0) > 0 || (metadata?.failedPaths?.length ?? 0) > 0) {
    throw new Error('Index is stale: note updates are incomplete or failed. Run obsidian_rag_index before preparing a snapshot.');
  }
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes) ||
      Object.values(hashes).some(hash => typeof hash !== 'string' || !/^[a-f0-9]{32}$/.test(hash))) {
    throw new Error('Invalid file-hashes.json. Run obsidian_rag_index before preparing a snapshot.');
  }
  if (!metadata || !Number.isFinite(metadata.indexedAt) || !Number.isFinite(metadata.latestMtimeMs) ||
      metadata.fileCount !== Object.keys(hashes).length) {
    throw new Error('Missing or inconsistent index freshness metadata. Run obsidian_rag_index before preparing a snapshot.');
  }
  return hashes as Record<string, string>;
}

function schemaSignature(schema: Schema): string {
  return JSON.stringify(schema.fields.map(field => ({ name: field.name, type: field.type.toString(), nullable: field.nullable })));
}

// Read every current row, including vectors. Compaction may reorder rows, so
// compare sorted row digests rather than physical record-batch order.
async function inspectTable(table: lancedb.Table, expectedSchema: Schema, hashes: Record<string, string>, policy: NotePolicy) {
  if (schemaSignature(await table.schema()) !== schemaSignature(expectedSchema)) {
    throw new Error('Incompatible notes table columns. Run obsidian_rag_index with force_reindex=true.');
  }
  const tags = await (await table.tags()).list();
  if (Object.keys(tags).length > 0) {
    throw new Error(`Tagged indexes are not supported by snapshot preparation. Retained tags: ${Object.keys(tags).join(', ')}. No tags were removed.`);
  }
  const indices = await table.listIndices();
  if (!indices.some(index => index.indexType === 'FTS' && index.columns.includes('embedding_text'))) {
    throw new Error('The index has no full-text index on embedding_text. Run obsidian_rag_index with force_reindex=true.');
  }
  const rowDigests: string[] = [];
  let queryVector: number[] | undefined;
  let queryText = 'snapshotvalidationprobe';
  for await (const batch of table.query()) {
    for (const row of batch.toArray()) {
      if (!policy.includes(String(row.path))) throw new Error(`Snapshot contains an excluded path: ${row.path}. Run obsidian_rag_index.`);
      if (!Object.hasOwn(hashes, row.path)) throw new Error(`Index row has no matching file hash: ${row.path}`);
      const vector = Array.from(row.vector as Iterable<number>);
      if (vector.length !== 384 || vector.some(value => !Number.isFinite(value))) {
        throw new Error('The index contains invalid embedding vectors. Reindex before preparing a snapshot.');
      }
      if (!queryVector) {
        queryVector = vector;
        queryText = String(row.embedding_text).match(/[a-zA-Z]{4,}/)?.[0] ?? queryText;
      }
      rowDigests.push(digest(JSON.stringify([
        row.id, row.path, row.text, row.embedding_text, row.heading_path,
        vector, Array.from(row.entities), Array.from(row.communities),
      ])));
    }
  }
  const vectorRows = await table.vectorSearch(queryVector ?? Array(384).fill(0)).limit(1).toArray();
  if (queryVector && vectorRows.length === 0) throw new Error('Snapshot vector query returned no rows.');
  // Empty/stop-word-only tables can legitimately return no FTS matches.
  await table.search(queryText, 'fts').limit(1).toArray();
  return {
    rows: rowDigests.length,
    contentSha256: digest(rowDigests.sort().join('\n')),
    vectorQuery: true,
    fullTextQuery: true,
  };
}

async function openNotes(basePath: string) {
  const db = await lancedb.connect(path.join(basePath, 'lancedb'));
  try {
    const names = await db.tableNames();
    if (names.length !== 1 || names[0] !== 'notes') {
      throw new Error('Snapshot preparation requires a local index containing only the notes table. Run obsidian_rag_index first.');
    }
    return { db, table: await db.openTable('notes') };
  } catch (error) { db.close(); throw error; }
}

async function normalizeCleanupTimestamps(copyPath: string, files: Inventory, versions: lancedb.Version[]) {
  // Lance filters file listings by the earliest retained manifest before it
  // considers deleteUnverified. Make all copied cleanup candidates eligible,
  // including abandoned writes newer than the latest manifest. The one-second
  // margin accommodates timestamp precision. Lance still checks references.
  const oldestManifestTime = versions.reduce((oldest, version) => Math.min(oldest, version.timestamp.getTime()), Infinity);
  const timestamp = new Date(oldestManifestTime - 1000);
  for (const file of files) {
    if (/^lancedb\/notes\.lance\/(data|_indices|_deletions|_transactions)\//.test(file.path)) {
      await fs.utimes(path.join(copyPath, file.path), timestamp, timestamp);
    }
  }
}

/** Caller holds both index locks until this operation finishes. */
export async function prepareSnapshot(
  basePath: string,
  expectedSchema: Schema,
  schemaVersion: number,
  policy: NotePolicy,
  assertFresh: (hashes: Record<string, string>) => Promise<void>,
): Promise<SnapshotResult> {
  const snapshotRoot = path.join(basePath, 'snapshots');
  // Reject redirected output directories before reading or writing an export.
  for (const directory of [basePath, snapshotRoot]) {
    if (await exists(directory) && (await fs.lstat(directory)).isSymbolicLink()) {
      throw new Error(`Snapshot paths must not contain symbolic links: ${directory}`);
    }
  }
  if (!await exists(path.join(basePath, 'lancedb', 'notes.lance'))) {
    throw new Error('No index to export. Run obsidian_rag_index first.');
  }
  const sourceFiles = await inventory(basePath, PAYLOAD_ENTRIES);
  const tableDirectories = new Set(['_versions', '_indices', '_deletions', '_transactions', '_refs', 'data']);
  for (const file of sourceFiles) {
    if (!file.path.startsWith('lancedb/')) continue;
    const parts = file.path.split('/');
    if (parts[1] !== 'notes.lance' || !tableDirectories.has(parts[2])) {
      throw new Error(`Unsupported local index layout: ${file.path}`);
    }
    if (parts[2] === '_versions') {
      if (parts.length !== 4 || !parts[3].endsWith('.manifest')) {
        throw new Error(`Unsupported Lance version file: ${file.path}`);
      }
      await assertLocalManifest(path.join(basePath, file.path), ENGINE_VERSION);
    }
  }
  const hashes = await readMetadata(basePath, schemaVersion);
  await assertFresh(hashes);
  if (await exists(snapshotRoot)) {
    // Both index locks are held, so no other supported exporter can own a
    // staging directory. Reclaim abandoned copies even when reusing output.
    // Leave published generations, symlinks, and unrelated entries alone.
    for (const entry of await fs.readdir(snapshotRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\.preparing-[a-zA-Z0-9]{6}$/.test(entry.name)) {
        await fs.rm(path.join(snapshotRoot, entry.name), { recursive: true, force: true });
      }
    }
  }
  const sourceFingerprint = digest(JSON.stringify({ policy: POLICY_VERSION, rulesFingerprint: policy.fingerprint, engine: ENGINE_VERSION, files: sourceFiles }));
  const snapshotPath = path.join(snapshotRoot, sourceFingerprint);
  if (await exists(snapshotPath)) {
    if ((await fs.lstat(snapshotPath)).isSymbolicLink()) {
      throw new Error(`Snapshot paths must not contain symbolic links: ${snapshotPath}`);
    }
    const files = await inventory(snapshotPath);
    const manifest = JSON.parse(await fs.readFile(path.join(snapshotPath, MANIFEST_FILE), 'utf8')) as SnapshotManifest;
    if (manifest.policyVersion !== POLICY_VERSION || manifest.rulesFingerprint !== policy.fingerprint ||
        manifest.result?.rulesFingerprint !== policy.fingerprint || manifest.result?.sourceFingerprint !== sourceFingerprint ||
        !sameInventory(files.filter(file => file.path !== MANIFEST_FILE), manifest.files)) {
      throw new Error(`Existing snapshot is incomplete or modified: ${snapshotPath}. Move it aside before retrying; it will not be overwritten.`);
    }
    await assertFresh(hashes);
    return { ...manifest.result, snapshotPath, reused: true };
  }

  await fs.mkdir(snapshotRoot, { recursive: true });
  const temporaryPath = await fs.mkdtemp(path.join(snapshotRoot, '.preparing-'));
  try {
    // Copy named payload entries only. Locks, temporary metadata, and other
    // exports never belong to the shared database. No hard links are used.
    // Preserve metadata timestamps here; normalize cleanup candidates only
    // after checking the private copy's contents and database versions.
    for (const entry of PAYLOAD_ENTRIES) {
      await fs.cp(path.join(basePath, entry), path.join(temporaryPath, entry), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    }
    if (!sameInventory(sourceFiles, await inventory(temporaryPath)) ||
        !sameInventory(sourceFiles, await inventory(basePath, PAYLOAD_ENTRIES))) {
      throw new Error('Index changed while capturing the snapshot. Retry after indexing finishes.');
    }
    const { db, table } = await openNotes(temporaryPath);
    let sourceVersion: number;
    let versionsBefore: number[];
    let versionsRetained: number[];
    let validation: SnapshotResult['validation'];
    const cutoff = new Date();
    try {
      sourceVersion = await table.version();
      const versions = await table.listVersions();
      versionsBefore = versions.map(version => version.version);
      validation = await inspectTable(table, expectedSchema, hashes, policy);
      // This unpublished copy has no concurrent readers or writers. External
      // references were rejected before copying, so cleanup stays in this copy.
      await normalizeCleanupTimestamps(temporaryPath, sourceFiles, versions);
      await table.optimize({ cleanupOlderThan: cutoff, deleteUnverified: true });
      versionsRetained = (await table.listVersions()).map(version => version.version);
    } finally { table.close(); db.close(); }

    // Reopen the maintained copy without the indexer's cached connection.
    const reopened = await openNotes(temporaryPath);
    try {
      const afterValidation = await inspectTable(reopened.table, expectedSchema, hashes, policy);
      if (JSON.stringify(afterValidation) !== JSON.stringify(validation)) {
        throw new Error('Snapshot validation failed: maintenance changed the current rows or embeddings.');
      }
    } finally { reopened.table.close(); reopened.db.close(); }
    await assertFresh(hashes);
    if (!sameInventory(sourceFiles, await inventory(basePath, PAYLOAD_ENTRIES))) {
      throw new Error('Index changed during snapshot preparation. Retry after indexing finishes.');
    }
    const files = await inventory(temporaryPath);
    const result: SnapshotResult = {
      success: true, snapshotPath, rulesFingerprint: policy.fingerprint, sourceFingerprint, sourceVersion, reused: false,
      before: totals(sourceFiles), after: totals(files), versionsBefore, versionsRetained,
      versionsRemoved: versionsBefore.filter(version => !versionsRetained.includes(version)),
      retention: { olderThan: cutoff.toISOString(), deleteUnverified: true },
      compaction: 'once-per-source-state', validation,
      compatibility: { notesTableSchemaVersion: schemaVersion, lanceDbVersion: ENGINE_VERSION },
    };
    const manifest: SnapshotManifest = { policyVersion: POLICY_VERSION, rulesFingerprint: policy.fingerprint, files, result };
    await fs.writeFile(path.join(temporaryPath, MANIFEST_FILE), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    // The final name only appears after every validation succeeds. A process
    // killed before this rename leaves an unpublished .preparing-* directory.
    await assertFresh(hashes);
    await fs.rename(temporaryPath, snapshotPath);
    return result;
  } finally {
    await fs.rm(temporaryPath, { recursive: true, force: true });
  }
}
