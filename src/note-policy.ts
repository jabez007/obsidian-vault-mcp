import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { glob } from 'glob';
import ignore from 'ignore';
import { getSafeFilePath, resolveRealPathAllowMissing } from './utils.js';

export const IGNORE_FILE_NAME = '.obsidian-mcpignore';
export const INDEX_METADATA_VERSION = 2;
// Change this when built-in exclusions, normalization, or matching semantics change.
const RULES_VERSION = 1;

export class NotePolicyError extends Error {
  constructor(message: string, public readonly code = 'INVALID_NOTE_POLICY') {
    super(message);
  }
}

export function normalizeNotePath(relativePath: string): string {
  return path.posix.normalize(relativePath.replace(/\\/g, '/'));
}

export function isMarkdownNotePath(relativePath: string): boolean {
  const normalized = normalizeNotePath(relativePath);
  return !path.posix.isAbsolute(normalized) && normalized.endsWith('.md') &&
    !normalized.split('/').some(segment => segment.startsWith('.'));
}

export class NotePolicy {
  readonly fingerprint: string;
  private readonly matcher = ignore({ ignorecase: false });

  constructor(text: string) {
    const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    const rules: string[] = [];
    lines.forEach((line, index) => {
      const fail = (reason: string): never => {
        throw new NotePolicyError(`${IGNORE_FILE_NAME}:${index + 1}: ${reason}`);
      };
      if (line.includes('\0')) fail('NUL characters are not allowed.');
      if (line.startsWith('!')) fail('Negation is not supported. Escape a literal leading ! with \\!.');
      if (/^\s*$/.test(line) || line.startsWith('#')) return;
      try {
        this.matcher.add(line);
        // Compile lazy matcher expressions while the source line is known.
        this.matcher.ignores('__obsidian_policy_validation__.md');
      } catch (error) { fail(String(error)); }
      rules.push(line);
    });
    this.fingerprint = createHash('sha256').update(JSON.stringify({ version: RULES_VERSION, rules })).digest('hex');
  }

  includes(relativePath: string): boolean {
    const normalized = normalizeNotePath(relativePath);
    return isMarkdownNotePath(normalized) && !this.matcher.ignores(normalized);
  }

  async assertUnchanged(vaultPath: string): Promise<void> {
    if ((await loadNotePolicy(vaultPath)).fingerprint !== this.fingerprint) {
      throw new NotePolicyError(`${IGNORE_FILE_NAME} changed during this operation. Retry; run obsidian_rag_index to reconcile the index.`, 'NOTE_POLICY_CHANGED');
    }
  }
}

export async function loadNotePolicy(vaultPath: string): Promise<NotePolicy> {
  // Only an absent directory entry means "no rules". A dangling symlink is
  // an unreadable policy, even though reading it also reports ENOENT.
  try {
    await fs.lstat(path.join(vaultPath, IGNORE_FILE_NAME));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new NotePolicy('');
    throw new NotePolicyError(`Cannot inspect ${IGNORE_FILE_NAME}: ${String(error)}`);
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(getSafeFilePath(vaultPath, IGNORE_FILE_NAME));
  } catch (error) {
    throw new NotePolicyError(`Cannot read ${IGNORE_FILE_NAME}: ${String(error)}`);
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch {
    throw new NotePolicyError(`${IGNORE_FILE_NAME} must contain valid UTF-8.`);
  }
  return new NotePolicy(text);
}

export async function discoverNotes(vaultPath: string, policy: NotePolicy, pattern = '**/*.md'): Promise<string[]> {
  const files = await glob(pattern, { cwd: vaultPath, follow: true, dot: false, nocase: false, nodir: true });
  return files.filter(file => {
    if (!policy.includes(file)) return false;
    try { getSafeFilePath(vaultPath, file); return true; } catch { return false; }
  });
}

export function assertNoteMutationAllowed(vaultPath: string, relativePath: string): void {
  const candidate = getSafeFilePath(vaultPath, relativePath);
  const protectedPath = path.join(vaultPath, IGNORE_FILE_NAME);
  if (path.resolve(candidate) === path.resolve(protectedPath) ||
      resolveRealPathAllowMissing(candidate) === resolveRealPathAllowMissing(protectedPath)) {
    throw new NotePolicyError(`Note tools cannot change ${IGNORE_FILE_NAME}. Edit it directly.`);
  }
}
