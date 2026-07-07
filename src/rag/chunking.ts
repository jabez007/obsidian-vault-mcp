import md5 from 'md5';
import { splitMarkdownByHeadingBreadcrumbs } from '../utils.js';

export interface ChunkingOptions {
  minChunkChars?: number;
  maxChunkChars?: number;
  targetChunkChars?: number;
  graphMetadata?: {
    entities?: string[];
    communities?: string[];
  };
}

const DEFAULTS = {
  minChunkChars: 40,
  maxChunkChars: 1800,
  targetChunkChars: 700,
} as const;

/**
 * Normalizes an unknown value to a string array.
 * Coerces single strings to [string], filters out non-string entries in arrays, 
 * and returns [] for all other types.
 */
export function normalizeToStringArray(val: unknown): string[] {
  if (Array.isArray(val)) {
    return val.filter((item): item is string => typeof item === 'string');
  }
  if (typeof val === 'string') {
    return [val];
  }
  return [];
}

export function splitTextForEmbedding(text: string, maxChars: number = DEFAULTS.maxChunkChars): string[] {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxChars) return [normalized];

  const segments: string[] = [];
  const sentenceParts = normalized.split(/(?<=[.!?])\s+/);
  let current = '';

  for (const part of sentenceParts) {
    if (part.length > maxChars) {
      if (current.length > 0) {
        segments.push(current);
        current = '';
      }
      for (let i = 0; i < part.length; i += maxChars) {
        segments.push(part.slice(i, i + maxChars));
      }
      continue;
    }

    const candidate = current.length > 0 ? `${current} ${part}` : part;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current.length > 0) segments.push(current);
      current = part;
    }
  }

  if (current.length > 0) segments.push(current);
  return segments;
}

export interface NoteMetadata {
  id: string;
  path: string;
  text: string;
  embedding_text: string;
  heading_path: string;
  entities: string[];
  communities: string[];
}

export interface TextSegment {
  text: string;
  headingPath: string;
}

export function mergeTextSegments(segments: TextSegment[], targetChars: number): TextSegment[] {
  if (segments.length === 0) return [];
  const merged: TextSegment[] = [];
  let current: TextSegment | null = null;

  const flush = () => {
    if (current) {
      merged.push(current);
      current = null;
    }
  };

  for (const segment of segments) {
    if (segment.text.length >= targetChars) {
      flush();
      merged.push(segment);
      continue;
    }

    if (!current) {
      current = segment;
      continue;
    }

    const candidate: string = `${current.text}\n\n${segment.text}`;
    if (current.headingPath === segment.headingPath && candidate.length <= targetChars) {
      current = { ...current, text: candidate };
    } else {
      flush();
      current = segment;
    }
  }

  flush();
  return merged;
}

function buildContextualEmbeddingText(
  cleanText: string,
  headingPath: string,
  entities: string[],
  communities: string[],
  maxChunkChars: number,
): string {
  // Entities/communities come before the heading so that when the context
  // budget runs out, right-truncation drops breadcrumb detail rather than
  // the graph metadata the filters and keyword search depend on.
  const parts = [];
  if (entities.length > 0) parts.push(`Entities: ${entities.join(', ')}`);
  if (communities.length > 0) parts.push(`Communities: ${communities.join(', ')}`);
  if (headingPath.length > 0) parts.push(`Heading: ${headingPath}`);

  if (parts.length === 0) {
    return cleanText.length > maxChunkChars ? cleanText.slice(0, maxChunkChars) : cleanText;
  }

  const context = parts.join(' | ');
  // Wrapper: "[METADATA: " (11) + "]\n\n" (3) = 14 chars
  const wrapperOverhead = 14;
  const contextBudget = Math.max(0, maxChunkChars - wrapperOverhead);
  const minContextChars = Math.min(20, contextBudget, context.length);
  const maxBaseTextLen = Math.max(0, maxChunkChars - wrapperOverhead - minContextChars);
  const baseText = cleanText.length > maxBaseTextLen ? cleanText.slice(0, maxBaseTextLen) : cleanText;
  const availableContextChars = Math.max(0, maxChunkChars - baseText.length - wrapperOverhead);
  const contextual = context.length > availableContextChars
    ? context.slice(0, availableContextChars)
    : context;

  return `[METADATA: ${contextual}]\n\n${baseText}`;
}

export function buildEmbeddingInputs(relativePath: string, body: string, options?: ChunkingOptions): { 
  textsToEmbed: string[], 
  chunkMetadata: NoteMetadata[] 
} {
  const minChunkChars = options?.minChunkChars ?? DEFAULTS.minChunkChars;
  const maxChunkChars = options?.maxChunkChars ?? DEFAULTS.maxChunkChars;
  const targetChunkChars = options?.targetChunkChars ?? DEFAULTS.targetChunkChars;

  const blocks = splitMarkdownByHeadingBreadcrumbs(body);
  const rawSegments: TextSegment[] = [];
  const chunkMetadata: NoteMetadata[] = [];

  for (const block of blocks) {
    const paragraph = block.text.trim();
    if (paragraph.length < minChunkChars) continue;

    const segments = splitTextForEmbedding(paragraph, maxChunkChars);
    for (const segment of segments) {
      if (segment.length < minChunkChars) continue;
      rawSegments.push({ text: segment, headingPath: block.headingPath });
    }
  }

  const cleanChunks = mergeTextSegments(rawSegments, Math.min(targetChunkChars, maxChunkChars));
  const entities = options?.graphMetadata?.entities ?? [];
  const communities = options?.graphMetadata?.communities ?? [];
  const textsToEmbed = cleanChunks.map((chunk) =>
    buildContextualEmbeddingText(chunk.text, chunk.headingPath, entities, communities, maxChunkChars)
  );

  for (let chunkIndex = 0; chunkIndex < cleanChunks.length; chunkIndex++) {
    const cleanChunk = cleanChunks[chunkIndex];
    const meta: NoteMetadata = {
      id: md5(`${relativePath}-${chunkIndex}`),
      path: relativePath,
      text: cleanChunk.text,
      embedding_text: textsToEmbed[chunkIndex],
      heading_path: cleanChunk.headingPath,
      entities,
      communities,
    };
    
    chunkMetadata.push(meta);
  }

  return { textsToEmbed, chunkMetadata };
}
