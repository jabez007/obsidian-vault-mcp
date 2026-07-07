import md5 from 'md5';

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

export function mergeSegmentsForEmbedding(segments: string[], targetChars: number): string[] {
  if (segments.length === 0) return [];
  const merged: string[] = [];
  let current = '';

  for (const segment of segments) {
    if (segment.length >= targetChars) {
      if (current.length > 0) {
        merged.push(current);
        current = '';
      }
      merged.push(segment);
      continue;
    }

    const candidate = current.length > 0 ? `${current}\n\n${segment}` : segment;
    if (candidate.length <= targetChars) {
      current = candidate;
    } else {
      if (current.length > 0) merged.push(current);
      current = segment;
    }
  }

  if (current.length > 0) merged.push(current);
  return merged;
}

export interface NoteMetadata {
  id: string;
  path: string;
  text: string;
  entities: string[];
  communities: string[];
}

export function buildEmbeddingInputs(relativePath: string, body: string, options?: ChunkingOptions): { 
  textsToEmbed: string[], 
  chunkMetadata: NoteMetadata[] 
} {
  const minChunkChars = options?.minChunkChars ?? DEFAULTS.minChunkChars;
  const maxChunkChars = options?.maxChunkChars ?? DEFAULTS.maxChunkChars;
  const targetChunkChars = options?.targetChunkChars ?? DEFAULTS.targetChunkChars;

  const paragraphs = body.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  const rawSegments: string[] = [];
  const chunkMetadata: NoteMetadata[] = [];

  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i].trim();
    if (paragraph.length < minChunkChars) continue;

    const segments = splitTextForEmbedding(paragraph, maxChunkChars);
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
      const segment = segments[segmentIndex];
      if (segment.length < minChunkChars) continue;
      rawSegments.push(segment);
    }
  }

  const textsToEmbed = mergeSegmentsForEmbedding(rawSegments, Math.min(targetChunkChars, maxChunkChars));
  const entities = options?.graphMetadata?.entities;
  const communities = options?.graphMetadata?.communities;

  // Wrapper: "[METADATA: " (11) + "]\n\n" (3) = 14 chars
  const wrapperOverhead = 14;
  const minMetadataChars = 20; // Ensure at least 20 chars of metadata if present

  const finalTexts = textsToEmbed.map(text => {
    const hasMetadata = (entities && entities.length > 0) || (communities && communities.length > 0);
    
    // If we have metadata, we MUST leave room for it.
    // We truncate the base text to ensure at least minMetadataChars can fit.
    const effectiveMaxTextLen = hasMetadata 
      ? maxChunkChars - wrapperOverhead - minMetadataChars
      : maxChunkChars;

    const baseText = text.length > effectiveMaxTextLen ? text.slice(0, effectiveMaxTextLen) : text;

    if (!hasMetadata) {
      return baseText;
    }

    const parts = [];
    if (entities && entities.length > 0) parts.push(`Entities: ${entities.join(', ')}`);
    if (communities && communities.length > 0) parts.push(`Communities: ${communities.join(', ')}`);
    const fullMetaContent = parts.join(' | ');

    const available = maxChunkChars - baseText.length - wrapperOverhead;
    // available will be at least minMetadataChars (20) because of effectiveMaxTextLen

    const truncatedMeta = fullMetaContent.length > available
      ? fullMetaContent.slice(0, available)
      : fullMetaContent;

    return `[METADATA: ${truncatedMeta}]\n\n${baseText}`;
  });

  for (let chunkIndex = 0; chunkIndex < finalTexts.length; chunkIndex++) {
    const meta: NoteMetadata = {
      id: md5(`${relativePath}-${chunkIndex}`),
      path: relativePath,
      text: finalTexts[chunkIndex],
      entities: entities ?? [],
      communities: communities ?? [],
    };
    
    chunkMetadata.push(meta);
  }

  return { textsToEmbed: finalTexts, chunkMetadata };
}
