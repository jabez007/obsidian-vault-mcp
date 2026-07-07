import { describe, it, expect } from 'vitest';
import { splitTextForEmbedding, mergeSegmentsForEmbedding, buildEmbeddingInputs } from '../src/rag/chunking';

describe('splitTextForEmbedding', () => {
  it('returns short text as-is', () => {
    const result = splitTextForEmbedding('Hello world.', 100);
    expect(result).toEqual(['Hello world.']);
  });

  it('normalizes whitespace', () => {
    const result = splitTextForEmbedding('  Hello   world.  ', 100);
    expect(result).toEqual(['Hello world.']);
  });

  it('splits on sentence boundaries', () => {
    const result = splitTextForEmbedding(
      'First sentence. Second sentence. Third sentence.',
      30
    );
    expect(result.length).toBeGreaterThan(1);
    expect(result.join(' ')).toContain('First sentence.');
  });

  it('force-splits text longer than maxChars with no sentence boundaries', () => {
    const long = 'a'.repeat(50);
    const result = splitTextForEmbedding(long, 20);
    expect(result.length).toBe(3);
    expect(result[0]).toBe('a'.repeat(20));
    expect(result[1]).toBe('a'.repeat(20));
    expect(result[2]).toBe('a'.repeat(10));
  });

  it('handles text at exactly maxChars', () => {
    const text = 'a'.repeat(100);
    const result = splitTextForEmbedding(text, 100);
    expect(result).toEqual([text]);
  });

  it('handles empty string', () => {
    const result = splitTextForEmbedding('', 100);
    expect(result).toEqual(['']);
  });
});

describe('mergeSegmentsForEmbedding', () => {
  it('returns empty array for empty input', () => {
    expect(mergeSegmentsForEmbedding([], 100)).toEqual([]);
  });

  it('returns single segment unchanged', () => {
    expect(mergeSegmentsForEmbedding(['hello'], 100)).toEqual(['hello']);
  });

  it('merges small segments with double-newline separator', () => {
    const result = mergeSegmentsForEmbedding(['aaa', 'bbb'], 100);
    expect(result).toEqual(['aaa\n\nbbb']);
  });

  it('keeps large segments standalone', () => {
    const large = 'a'.repeat(100);
    const result = mergeSegmentsForEmbedding([large, 'small'], 100);
    expect(result).toEqual([large, 'small']);
  });

  it('does not merge beyond target size', () => {
    const result = mergeSegmentsForEmbedding(['aaaa', 'bbbb', 'cccc'], 10);
    // 'aaaa\n\nbbbb' = 10 chars, fits. 'cccc' would push past, so separate.
    expect(result).toEqual(['aaaa\n\nbbbb', 'cccc']);
  });
});

describe('buildEmbeddingInputs', () => {
  it('filters paragraphs shorter than minChunkChars', () => {
    const body = 'Hi\n\nThis is a longer paragraph that should pass the filter.';
    const result = buildEmbeddingInputs('test.md', body, { minChunkChars: 10 });
    expect(result.textsToEmbed.length).toBe(1);
    expect(result.textsToEmbed[0]).toContain('longer paragraph');
  });

  it('produces deterministic chunk IDs via md5', () => {
    const body = 'This is a sufficiently long paragraph for testing chunk IDs.';
    const r1 = buildEmbeddingInputs('note.md', body);
    const r2 = buildEmbeddingInputs('note.md', body);
    expect(r1.chunkMetadata[0].id).toBe(r2.chunkMetadata[0].id);
  });

  it('uses different IDs for different paths', () => {
    const body = 'This is a sufficiently long paragraph for testing chunk IDs.';
    const r1 = buildEmbeddingInputs('a.md', body);
    const r2 = buildEmbeddingInputs('b.md', body);
    expect(r1.chunkMetadata[0].id).not.toBe(r2.chunkMetadata[0].id);
  });

  it('sets path on chunk metadata', () => {
    const body = 'A paragraph long enough to be included in the output chunks.';
    const result = buildEmbeddingInputs('folder/note.md', body);
    expect(result.chunkMetadata[0].path).toBe('folder/note.md');
  });

  it('stores graph metadata as string arrays', () => {
    const body = 'A paragraph long enough to be included in the output chunks.';
    const result = buildEmbeddingInputs('test.md', body, {
      graphMetadata: {
        entities: ['AI', 'Climate Change'],
        communities: ['Technology'],
      },
    });

    expect(result.chunkMetadata[0].entities).toEqual(['AI', 'Climate Change']);
    expect(result.chunkMetadata[0].communities).toEqual(['Technology']);
  });

  it('respects custom options', () => {
    const body = 'Short.\n\nA medium length paragraph here.\n\nAnother medium paragraph here too.';
    const result = buildEmbeddingInputs('test.md', body, {
      minChunkChars: 5,
      maxChunkChars: 500,
      targetChunkChars: 200,
    });
    expect(result.textsToEmbed.length).toBeGreaterThan(0);
  });

  it('returns empty for body with no qualifying paragraphs', () => {
    const body = 'Hi\n\nOk';
    const result = buildEmbeddingInputs('test.md', body, { minChunkChars: 50 });
    expect(result.textsToEmbed).toEqual([]);
    expect(result.chunkMetadata).toEqual([]);
  });
});
