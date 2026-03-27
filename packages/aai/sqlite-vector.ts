// Copyright 2025 the AAI authors. MIT license.
/**
 * SQLite-backed vector store with local embeddings.
 *
 * Persists data across restarts using a local SQLite database file.
 * Uses brute-force cosine similarity over `node:sqlite` — no native
 * extensions required. Fast enough for local dev (sub-ms for <10k vectors).
 * Embeddings are computed locally via `all-MiniLM-L6-v2` (384 dims) —
 * no external API key required. The model is downloaded on first use
 * (~86 MB) and cached in `.aai/models/`.
 */

import { DatabaseSync } from "node:sqlite";
import type { VectorEntry, VectorStore } from "./vector.ts";

/** Function that converts text into an embedding vector. */
export type EmbedFn = (text: string) => Promise<number[]>;

/**
 * Options for creating a SQLite-vec backed vector store.
 */
export type SqliteVecVectorStoreOptions = {
  /** Path to the SQLite database file. Defaults to `.aai/vectors.db`. */
  path?: string;
  /** Custom embedding function. Defaults to local `all-MiniLM-L6-v2` model. */
  embedFn?: EmbedFn;
  /** Embedding dimensions. Must match the embedFn output. Defaults to 384. */
  dimensions?: number;
  /** Directory for caching downloaded models. Defaults to `.aai/models`. */
  modelCacheDir?: string;
};

const DEFAULT_DIMENSIONS = 384;
const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

/**
 * Create a local embedding function using `all-MiniLM-L6-v2`.
 *
 * The model is downloaded on first use (~86 MB) and cached locally.
 * Subsequent calls load from cache in ~90ms. Each embedding takes <2ms.
 */
function createLocalEmbedFn(cacheDir: string): EmbedFn {
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

/** Cosine similarity between two vectors stored as Buffers of float32. */
function cosineSimilarity(a: Buffer, b: Buffer): number {
  const fa = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
  const fb = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < fa.length; i++) {
    const ai = fa[i] ?? 0;
    const bi = fb[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Create a SQLite-backed vector store with local embeddings.
 *
 * Data persists to a local SQLite file (default: `.aai/vectors.db`).
 * Embeddings are computed locally using `all-MiniLM-L6-v2` by default —
 * no API key required. The model auto-downloads on first use (~86 MB).
 *
 * Vector search uses brute-force cosine similarity over all stored
 * embeddings. This is fast for local dev workloads (<10k vectors).
 *
 * @param options - See {@link SqliteVecVectorStoreOptions}.
 * @returns A {@link VectorStore} instance.
 *
 * @example
 * ```ts
 * import { createSqliteVectorStore } from "@alexkroman1/aai/sqlite-vector";
 *
 * const vector = createSqliteVectorStore();
 * await vector.upsert("doc-1", "The capital of France is Paris.");
 * const results = await vector.query("France capital");
 * ```
 */
export function createSqliteVectorStore(options?: SqliteVecVectorStoreOptions): VectorStore {
  const dbPath = options?.path ?? ".aai/vectors.db";
  const cacheDir = options?.modelCacheDir ?? ".aai/models";
  const embedFn: EmbedFn = options?.embedFn ?? createLocalEmbedFn(cacheDir);

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS vectors (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '',
      embedding BLOB NOT NULL
    )
  `);

  const stmtUpsert = db.prepare(
    "INSERT OR REPLACE INTO vectors (id, data, metadata, embedding) VALUES (?, ?, ?, ?)",
  );
  const stmtDelete = db.prepare("DELETE FROM vectors WHERE id = ?");
  const stmtAll = db.prepare("SELECT id, data, metadata, embedding FROM vectors");

  return {
    async upsert(id: string, data: string, metadata?: Record<string, unknown>): Promise<void> {
      const vector = await embedFn(data);
      const embedding = Buffer.from(new Float32Array(vector).buffer);
      const metaJson = metadata ? JSON.stringify(metadata) : "";
      stmtUpsert.run(id, data, metaJson, embedding);
    },

    async query(
      text: string,
      queryOptions?: { topK?: number; filter?: string },
    ): Promise<VectorEntry[]> {
      const topK = queryOptions?.topK ?? 10;
      if (!text.trim()) return [];

      const queryVec = await embedFn(text);
      const queryBuf = Buffer.from(new Float32Array(queryVec).buffer);

      const rows = stmtAll.all() as {
        id: string;
        data: string;
        metadata: string;
        embedding: Buffer;
      }[];

      const scored = rows.map((row) => ({
        id: row.id,
        score: cosineSimilarity(queryBuf, row.embedding),
        data: row.data,
        metadata:
          row.metadata && row.metadata !== ""
            ? (JSON.parse(row.metadata) as Record<string, unknown>)
            : undefined,
      }));

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topK);
    },

    async delete(ids: string | string[]): Promise<void> {
      const idArray = Array.isArray(ids) ? ids : [ids];
      for (const id of idArray) {
        stmtDelete.run(id);
      }
    },
  };
}
