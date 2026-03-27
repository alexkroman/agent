// Copyright 2025 the AAI authors. MIT license.
/**
 * SQLite-vec backed vector store with local embeddings.
 *
 * Persists data across restarts using a local SQLite database file.
 * Uses the sqlite-vec extension for vector similarity search.
 * Embeddings are computed locally via `all-MiniLM-L6-v2` (384 dims) —
 * no external API key required. The model is downloaded on first use
 * (~86 MB) and cached in `.aai/models/`.
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
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

const TABLE_NAME = "vec_items";
const META_TABLE = "vec_meta";
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

/**
 * Create a SQLite-vec backed vector store with local embeddings.
 *
 * Data persists to a local SQLite file (default: `.aai/vectors.db`).
 * Embeddings are computed locally using `all-MiniLM-L6-v2` by default —
 * no API key required. The model auto-downloads on first use (~86 MB).
 *
 * @param options - See {@link SqliteVecVectorStoreOptions}.
 * @returns A {@link VectorStore} instance.
 *
 * @example
 * ```ts
 * import { createSqliteVecVectorStore } from "@alexkroman1/aai/sqlite-vec-vector";
 *
 * const vector = createSqliteVecVectorStore();
 * await vector.upsert("doc-1", "The capital of France is Paris.");
 * const results = await vector.query("France capital");
 * ```
 */
export function createSqliteVecVectorStore(options?: SqliteVecVectorStoreOptions): VectorStore {
  const dbPath = options?.path ?? ".aai/vectors.db";
  const dimensions = options?.dimensions ?? DEFAULT_DIMENSIONS;
  const cacheDir = options?.modelCacheDir ?? ".aai/models";
  const embedFn: EmbedFn = options?.embedFn ?? createLocalEmbedFn(cacheDir);

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  sqliteVec.load(db);

  // Metadata table: stores id, data, and metadata alongside the vec0 index.
  // vec0 auxiliary columns are limited, so we use a separate table joined by id.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${META_TABLE} (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT ''
    )
  `);

  // vec0 virtual table for vector search with cosine distance
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE_NAME} USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[${dimensions}] distance_metric=cosine
    )
  `);

  const stmtUpsertMeta = db.prepare(
    `INSERT OR REPLACE INTO ${META_TABLE} (id, data, metadata) VALUES (?, ?, ?)`,
  );
  const stmtDeleteMeta = db.prepare(`DELETE FROM ${META_TABLE} WHERE id = ?`);
  const stmtDeleteVec = db.prepare(`DELETE FROM ${TABLE_NAME} WHERE id = ?`);
  const stmtInsertVec = db.prepare(`INSERT INTO ${TABLE_NAME} (id, embedding) VALUES (?, ?)`);
  const stmtQuery = db.prepare(
    `SELECT v.id, v.distance, m.data, m.metadata
     FROM ${TABLE_NAME} v
     LEFT JOIN ${META_TABLE} m ON m.id = v.id
     WHERE v.embedding MATCH ?
     AND v.k = ?`,
  );

  const upsertTransaction = db.transaction(
    (id: string, data: string, metaJson: string, embedding: Float32Array) => {
      // Delete existing entry if present (vec0 doesn't support INSERT OR REPLACE)
      stmtDeleteVec.run(id);
      stmtDeleteMeta.run(id);
      stmtInsertVec.run(id, embedding);
      stmtUpsertMeta.run(id, data, metaJson);
    },
  );

  const deleteTransaction = db.transaction((id: string) => {
    stmtDeleteVec.run(id);
    stmtDeleteMeta.run(id);
  });

  return {
    async upsert(id: string, data: string, metadata?: Record<string, unknown>): Promise<void> {
      const vector = await embedFn(data);
      const metaJson = metadata ? JSON.stringify(metadata) : "";
      const embedding = new Float32Array(vector);
      upsertTransaction(id, data, metaJson, embedding);
    },

    async query(
      text: string,
      options?: { topK?: number; filter?: string },
    ): Promise<VectorEntry[]> {
      const topK = options?.topK ?? 10;
      if (!text.trim()) return [];

      const queryVec = await embedFn(text);
      const embedding = new Float32Array(queryVec);

      const rows = stmtQuery.all(embedding, topK) as {
        id: string;
        distance: number;
        data: string | null;
        metadata: string | null;
      }[];

      return rows.map((row) => ({
        id: row.id,
        score: 1 - row.distance, // cosine distance -> similarity
        data: row.data ?? undefined,
        metadata:
          row.metadata && row.metadata !== ""
            ? (JSON.parse(row.metadata) as Record<string, unknown>)
            : undefined,
      }));
    },

    async delete(ids: string | string[]): Promise<void> {
      const idArray = Array.isArray(ids) ? ids : [ids];
      for (const id of idArray) {
        deleteTransaction(id);
      }
    },
  };
}
