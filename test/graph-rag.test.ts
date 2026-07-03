import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { VaultIndexer } from '../src/rag/store';

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

describe('Graph-aware RAG', () => {
  let tempDir: string;
  let vaultPath: string;
  let workspacePath: string;
  let indexer: VaultIndexer;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-vault-mcp-graph-test-'));
    vaultPath = path.join(tempDir, 'my-vault');
    workspacePath = path.join(tempDir, 'my-workspace');
    await fs.mkdir(vaultPath, { recursive: true });
    await fs.mkdir(workspacePath, { recursive: true });
    indexer = new VaultIndexer();
  });

  afterEach(async () => {
    if (indexer) {
      await indexer.reset();
    }
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('prepends graph metadata to chunks when present in frontmatter', async () => {
    const noteContent = `---
entities: [AI, Climate Change]
communities: [Sustainability, Technology]
---
This is a note about how Artificial Intelligence can help in monitoring and mitigating the effects of Climate Change. It is a long enough note to be indexed correctly and pass the character limit.
`;
    const notePath = path.join(vaultPath, 'graph-note.md');
    await fs.writeFile(notePath, noteContent, 'utf-8');

    await indexer.indexVault(vaultPath, true, workspacePath);

    const searchResults = await indexer.search('AI', vaultPath, 5, workspacePath);
    
    expect(searchResults.length).toBeGreaterThan(0);
    const firstChunk = searchResults[0];
    
    // Check if the metadata is prepended to the text
    expect(firstChunk.text).toContain('[METADATA: Entities: AI, Climate Change | Communities: Sustainability, Technology]');
    expect(firstChunk.text).toContain('Artificial Intelligence');
    
    // Check if metadata is also stored in separate columns (if implemented)
    expect(firstChunk.entities).toBe('AI, Climate Change');
    expect(firstChunk.communities).toBe('Sustainability, Technology');
  });

  it('handles notes without graph metadata normally', async () => {
    const noteContent = `---
title: Simple Note
---
This is just a simple note without any special graph entities or communities in the frontmatter. It should be indexed normally without any prepended metadata block.
`;
    const notePath = path.join(vaultPath, 'simple-note.md');
    await fs.writeFile(notePath, noteContent, 'utf-8');

    await indexer.indexVault(vaultPath, true, workspacePath);

    const searchResults = await indexer.search('simple', vaultPath, 5, workspacePath);
    
    expect(searchResults.length).toBeGreaterThan(0);
    const firstChunk = searchResults[0];
    
    expect(firstChunk.text).not.toContain('[METADATA:');
    expect(firstChunk.entities).toBe('');
    expect(firstChunk.communities).toBe('');
  });

  it('handles single string metadata (not just arrays)', async () => {
    const noteContent = `---
entities: AI
communities: Sustainability
---
This is a note with single string metadata.
`;
    const notePath = path.join(vaultPath, 'single-string.md');
    await fs.writeFile(notePath, noteContent, 'utf-8');

    await indexer.indexVault(vaultPath, true, workspacePath);

    const searchResults = await indexer.search('AI', vaultPath, 5, workspacePath);
    
    expect(searchResults.length).toBeGreaterThan(0);
    const firstChunk = searchResults[0];
    
    expect(firstChunk.text).toContain('[METADATA: Entities: AI | Communities: Sustainability]');
    expect(firstChunk.entities).toBe('AI');
    expect(firstChunk.communities).toBe('Sustainability');
  });

  it('truncates metadata if it would exceed maxChunkChars', async () => {
    // We'll test the internal chunking function directly to verify truncation logic
    const { buildEmbeddingInputs } = await import('../src/rag/chunking');
    
    const longMetadata = {
      entities: ['Very Long Entity Name That Takes Up Space'.repeat(10)],
      communities: ['Another Very Long Community Name'.repeat(10)]
    };
    
    const body = 'This is a test note content that is long enough to be indexed.'.repeat(10);
    const maxChars = 200; // Small limit to trigger truncation
    
    const result = buildEmbeddingInputs('test.md', body, {
      graphMetadata: longMetadata,
      maxChunkChars: maxChars,
      targetChunkChars: 500 // Higher than max to test clamping
    });

    expect(result.textsToEmbed.length).toBeGreaterThan(0);
    for (const text of result.textsToEmbed) {
      expect(text.length).toBeLessThanOrEqual(maxChars);
      expect(text).toContain('[METADATA: ');
    }
  });
});
