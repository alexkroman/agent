// Copyright 2025 the AAI authors. MIT license.
/**
 * Vector store backed by unstorage.
 *
 * Stores all vectors for a scope in a single blob (JSON with base64-encoded
 * embeddings). Works with any unstorage driver. Brute-force cosine similarity
 * — fast for <10k vectors.
 */

import type { Storage } from "unstorage";
import {
  cosineSimilarity,
  createLocalEmbedFn,
  DEFAULT_DIMENSIONS,
  decodeEmbedding,
  type EmbedFn,
  encodeEmbedding,
} from "./_embeddings.ts";
import type { VectorEntry, VectorStore } from "./vector.ts";

// Re-export for consumers
export { createTestEmbedFn, type EmbedFn } from "./_embeddings.ts";

/** Blob format stored in unstorage. */
type VectorBlob = {
  v: 1;
  d: number;
  entries: Record<
    string,
    {
      data: string;
      meta?: Record<string, unknown>;
      emb: string; // base64-encoded Float32Array
    }
  >;
};

/** In-memory cache of the vector blob. */
type CachedEntry = {
  data: string;
  metadata?: Record<string, unknown>;
  embedding: Float32Array;
};

/**
 * Options for creating an unstorage-backed vector store.
 */
export type UnstorageVectorOptions = {
  /** Configured unstorage Storage instance. */
  storage: Storage;
  /** Key for the vector blob in storage. Defaults to `"vectors.json"`. */
  blobKey?: string;
  /** Custom embedding function. Defaults to local `all-MiniLM-L6-v2` model. */
  embedFn?: EmbedFn;
  /** Embedding dimensions. Must match the embedFn output. Defaults to 384. */
  dimensions?: number;
  /** Directory for caching downloaded models. Defaults to `.aai/models`. */
  modelCacheDir?: string;
};

/**
 * Create a vector store backed by any unstorage driver.
 *
 * All vectors for the scope are stored in a single blob. The blob is loaded
 * lazily on first operation and cached in memory. Mutations are written
 * through immediately.
 *
 * @param options - See {@link UnstorageVectorOptions}.
 * @returns A {@link VectorStore} instance.
 *
 * @example
 * ```ts
 * import { createStorage } from "unstorage";
 * import { createUnstorageVectorStore } from "@alexkroman1/aai/unstorage-vector";
 *
 * const vector = createUnstorageVectorStore({ storage: createStorage() });
 * await vector.upsert("doc-1", "The capital of France is Paris.");
 * const results = await vector.query("France capital");
 * ```
 */
export function createUnstorageVectorStore(options: UnstorageVectorOptions): VectorStore {
  const {
    storage,
    blobKey = "vectors.json",
    dimensions = DEFAULT_DIMENSIONS,
    modelCacheDir = ".aai/models",
  } = options;
  const embedFn: EmbedFn = options.embedFn ?? createLocalEmbedFn(modelCacheDir);

  let cache: Map<string, CachedEntry> | null = null;

  async function loadCache(): Promise<Map<string, CachedEntry>> {
    if (cache) return cache;
    cache = new Map();
    const raw = await storage.getItem<VectorBlob>(blobKey);
    if (raw != null) {
      const blob = raw as VectorBlob;
      for (const [id, entry] of Object.entries(blob.entries)) {
        const cached: CachedEntry = {
          data: entry.data,
          embedding: decodeEmbedding(entry.emb),
        };
        if (entry.meta) cached.metadata = entry.meta;
        cache.set(id, cached);
      }
    }
    return cache;
  }

  async function flushCache(): Promise<void> {
    if (!cache) return;
    const entries: VectorBlob["entries"] = {};
    for (const [id, entry] of cache) {
      entries[id] = {
        data: entry.data,
        ...(entry.metadata ? { meta: entry.metadata } : {}),
        emb: encodeEmbedding(entry.embedding),
      };
    }
    const blob: VectorBlob = { v: 1, d: dimensions, entries };
    await storage.setItem(blobKey, blob);
  }

  return {
    async upsert(id: string, data: string, metadata?: Record<string, unknown>): Promise<void> {
      const c = await loadCache();
      const vector = await embedFn(data);
      const entry: CachedEntry = {
        data,
        embedding: new Float32Array(vector),
      };
      if (metadata) entry.metadata = metadata;
      c.set(id, entry);
      await flushCache();
    },

    async query(
      text: string,
      queryOptions?: { topK?: number; filter?: string },
    ): Promise<VectorEntry[]> {
      const topK = queryOptions?.topK ?? 10;
      if (queryOptions?.filter) {
        throw new Error("Metadata filter is not supported by the unstorage vector store");
      }
      if (!text.trim()) return [];

      const c = await loadCache();
      const queryVec = new Float32Array(await embedFn(text));

      const scored: VectorEntry[] = [];
      for (const [id, entry] of c) {
        scored.push({
          id,
          score: cosineSimilarity(queryVec, entry.embedding),
          data: entry.data,
          metadata: entry.metadata,
        });
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topK);
    },

    async delete(ids: string | string[]): Promise<void> {
      const c = await loadCache();
      const idArray = Array.isArray(ids) ? ids : [ids];
      for (const id of idArray) {
        c.delete(id);
      }
      await flushCache();
    },
  };
}
