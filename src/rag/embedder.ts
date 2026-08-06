import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

export class Embedder {
  private static instance: Embedder;
  private pipe: FeatureExtractionPipeline | null = null;
  private modelName = 'Xenova/all-MiniLM-L6-v2';

  private constructor() {}

  public static getInstance(): Embedder {
    if (!Embedder.instance) {
      Embedder.instance = new Embedder();
    }
    return Embedder.instance;
  }

  private async getPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.pipe) {
      console.error('Loading embedding model...');
      this.pipe = await pipeline('feature-extraction', this.modelName);
      console.error('Model loaded.');
    }
    return this.pipe!;
  }

  public async embed(text: string): Promise<number[]> {
    const pipe = await this.getPipeline();
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    // Output is a Tensor, we need to convert to array
    return Array.from(output.data);
  }

  public async embedBatch(texts: string[]): Promise<number[][]> {
    const pipe = await this.getPipeline();
    const output = await pipe(texts, { pooling: 'mean', normalize: true });
    // Output is a Tensor with dimensions [batch_size, embedding_dim]
    // We need to reshape the flat data array into an array of arrays
    const embeddingDim = output.dims[1];
    const embeddings: number[][] = [];
    for (let i = 0; i < output.dims[0]; i++) {
        embeddings.push(Array.from(output.data.slice(i * embeddingDim, (i + 1) * embeddingDim)));
    }
    return embeddings;
  }
}
