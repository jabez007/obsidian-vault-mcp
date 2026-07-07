import * as path from 'path';
import * as fs from 'fs';
import matter from 'gray-matter';

export function getFirstEnv(...keys: string[]): string | null {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

export function parseAllowedVaultRoots(): string[] | null {
  const raw = getFirstEnv(
    'OBSIDIAN_ALLOWED_VAULTS',
    'CODEX_OBSIDIAN_ALLOWED_VAULTS',
    'GEMINI_OBSIDIAN_ALLOWED_VAULTS',
  );
  if (!raw) return null;
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function entryExists(candidatePath: string): boolean {
  try {
    fs.lstatSync(candidatePath);
    return true;
  } catch {
    return false;
  }
}

const MAX_SYMLINK_DEPTH = 40;

export function resolveRealPathAllowMissing(candidatePath: string, symlinkDepth: number = 0): string {
  if (!path.isAbsolute(candidatePath)) {
    throw new Error(`Path must be absolute: ${candidatePath}`);
  }
  if (symlinkDepth > MAX_SYMLINK_DEPTH) {
    throw new Error(`Too many symbolic links: ${candidatePath}`);
  }

  const resolvedPath = path.resolve(candidatePath);
  let existingPath = resolvedPath;
  const missingParts: string[] = [];

  // Walk up with lstat so a dangling symlink counts as existing; treating it
  // as missing would let a link pointing outside the boundary masquerade as
  // an in-boundary file that a later write then creates at the link target.
  while (!entryExists(existingPath)) {
    const parent = path.dirname(existingPath);
    if (parent === existingPath) break;
    missingParts.unshift(path.basename(existingPath));
    existingPath = parent;
  }

  let realExistingPath: string;
  try {
    realExistingPath = fs.realpathSync.native(existingPath);
  } catch {
    // realpath fails when the deepest existing entry is a dangling symlink:
    // resolve the link target manually and keep resolving from there.
    const linkTarget = fs.readlinkSync(existingPath);
    realExistingPath = resolveRealPathAllowMissing(
      path.resolve(path.dirname(existingPath), linkTarget),
      symlinkDepth + 1,
    );
  }

  return missingParts.length > 0
    ? path.join(realExistingPath, ...missingParts)
    : realExistingPath;
}

export function isPathContainedByRoot(candidatePath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

/**
 * Resolve a user-supplied relative path against a vault root, ensuring
 * the result stays within the vault boundary.  Throws on traversal.
 */
export function getSafeFilePath(vaultPath: string, userInputPath: string): string {
  const resolvedVault = path.resolve(vaultPath);
  const resolvedTarget = path.resolve(resolvedVault, userInputPath);
  if (!resolvedTarget.startsWith(resolvedVault + path.sep) && resolvedTarget !== resolvedVault) {
    throw new Error("Security Error: Path traversal detected.");
  }
  const realVault = resolveRealPathAllowMissing(resolvedVault);
  const realTarget = resolveRealPathAllowMissing(resolvedTarget);
  const allowedRoots = [realVault, ...(parseAllowedVaultRoots() ?? []).map((root) => resolveRealPathAllowMissing(root))];
  if (!allowedRoots.some((root) => isPathContainedByRoot(realTarget, root))) {
    throw new Error("Security Error: Path traversal detected.");
  }
  return resolvedTarget;
}

/**
 * Extract deduplicated wikilink targets from markdown content.
 * Handles [[Simple]] and [[Link|Alias]] forms.
 */
export function extractWikilinks(content: string): string[] {
  const regex = /\[\[(.*?)(?:\|.*?)?\]\]/g;
  const links: string[] = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1]);
  }
  return [...new Set(links)];
}

export interface SectionRange {
  headingStart: number;
  headingEnd: number;
  bodyStart: number;
  bodyEnd: number;
  level: number;
}

/**
 * Find the range of a section under a heading in markdown content.
 * Returns null if heading not found.
 */
export function findSectionRange(content: string, heading: string): SectionRange | null {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRegex = new RegExp(`^(#{1,6})\\s+${escapedHeading}\\s*$`, 'm');
  const match = headingRegex.exec(content);
  if (!match) return null;

  const level = match[1].length;
  const headingStart = match.index;
  const headingEnd = headingStart + match[0].length;
  const bodyStart = headingEnd;

  // Find next heading at same or higher level (fewer or equal #'s)
  const rest = content.slice(bodyStart);
  const nextHeadingRegex = new RegExp(`^#{1,${level}}\\s`, 'm');
  const nextMatch = nextHeadingRegex.exec(rest);
  const bodyEnd = nextMatch ? bodyStart + nextMatch.index : content.length;

  return { headingStart, headingEnd, bodyStart, bodyEnd, level };
}

/**
 * Replace the body under a heading, preserving the heading line itself.
 * Returns the updated file content.
 */
export function replaceSection(fileContent: string, range: SectionRange, newBody: string): string {
  return fileContent.slice(0, range.bodyStart) + '\n' + newBody + '\n' + fileContent.slice(range.bodyEnd);
}

/**
 * Insert content under a heading at the given position.
 * If range is null (heading not found), appends a new ## section.
 * Returns the updated file content.
 */
export function insertAtHeading(
  fileContent: string,
  heading: string,
  content: string,
  position: 'beginning' | 'end',
  range: SectionRange | null,
): string {
  if (range) {
    if (position === 'beginning') {
      return fileContent.slice(0, range.bodyStart) + '\n' + content + fileContent.slice(range.bodyStart);
    }
    const before = fileContent.slice(0, range.bodyEnd);
    const sep = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
    return before + sep + content + '\n' + fileContent.slice(range.bodyEnd);
  }
  return fileContent + `\n\n## ${heading}\n${content}`;
}

/** Build the glob pattern for obsidian_list_notes. Recurses into subfolder when given. */
export function listNotesPattern(subfolder?: string): string {
  return subfolder ? path.join(subfolder, '**', '*.md') : '**/*.md';
}

/** Replace the first occurrence of oldText with newText. Throws if not found. */
export function replaceInNote(content: string, oldText: string, newText: string): string {
  const idx = content.indexOf(oldText);
  if (idx === -1) throw new Error(`Text not found: "${oldText}"`);
  return content.slice(0, idx) + newText + content.slice(idx + oldText.length);
}

/** Strip the #heading fragment from a wikilink target. */
export function stripHeadingFromLink(link: string): string {
  const idx = link.indexOf('#');
  return idx === -1 ? link : link.slice(0, idx);
}

type FrontmatterUpdate =
  | { key: string; value: string; updates?: never }
  | { updates: Record<string, unknown>; key?: never; value?: never };

/** Apply a single key/value or a batch of updates to YAML frontmatter. Returns updated file content. */
export function applyFrontmatterUpdate(fileContent: string, update: FrontmatterUpdate): string {
  const parsed = matter(fileContent);
  if (update.updates) {
    for (const [k, v] of Object.entries(update.updates)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      parsed.data[k] = v;
    }
  } else {
    let value: unknown = update.value;
    try { value = JSON.parse(String(update.value)); } catch { /* use as string */ }
    parsed.data[update.key] = value;
  }
  return matter.stringify(parsed.content, parsed.data);
}
