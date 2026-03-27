// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared embedding helpers for vector stores.
 *
 * Provides local embedding via `all-MiniLM-L6-v2` (384 dims),
 * a deterministic test embedding function, and cosine similarity.
 */

/** Function that converts text into an embedding vector. */
export type EmbedFn = (text: string) => Promise<number[]>;

export const DEFAULT_DIMENSIONS = 384;
const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

/**
 * Create a local embedding function using `all-MiniLM-L6-v2`.
 *
 * The model is downloaded on first use (~86 MB) and cached locally.
 * Subsequent calls load from cache in ~90ms. Each embedding takes <2ms.
 */
export function createLocalEmbedFn(cacheDir: string): EmbedFn {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import returns untyped pipeline
  let pipelinePromise: Promise<any> | null = null;

  async function getPipeline() {
    if (!pipelinePromise) {
      pipelinePromise = (async () => {
        const { pipeline, env } = await import("@huggingface/transformers");
        env.cacheDir = cacheDir;
        return pipeline("feature-extraction", DEFAULT_MODEL);
      })();
    }
    return pipelinePromise;
  }

  return async (text: string): Promise<number[]> => {
    const embedder = await getPipeline();
    const output = await embedder(text, { pooling: "mean", normalize: true });
    return Array.from(output.data as Float32Array);
  };
}

/**
 * Create a deterministic hash-based embedding function for testing.
 *
 * Produces repeatable vectors where similar text yields similar embeddings.
 * Not suitable for production — use the default local model instead.
 *
 * @param dimensions - Vector dimensions (default: 384).
 */
export function createTestEmbedFn(dimensions = DEFAULT_DIMENSIONS): EmbedFn {
  return async (text: string): Promise<number[]> => {
    const vec = new Float32Array(dimensions);
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    for (const word of words) {
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
      }
      for (let i = 0; i < 8; i++) {
        const idx = Math.abs((hash + i * 31_337) % dimensions);
        vec[idx] = (vec[idx] ?? 0) + 1;
      }
    }
    // Normalize to unit vector
    let norm = 0;
    for (let i = 0; i < dimensions; i++) norm += (vec[i] ?? 0) * (vec[i] ?? 0);
    norm = Math.sqrt(norm) || 1;
    return Array.from(vec, (v) => v / norm);
  };
}

/** Cosine similarity between two Float32Array vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Encode an embedding as a base64 string. */
export function encodeEmbedding(vec: Float32Array | number[]): string {
  const f32 = vec instanceof Float32Array ? vec : new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString("base64");
}

/** Decode a base64 string back to a Float32Array embedding. */
export function decodeEmbedding(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
