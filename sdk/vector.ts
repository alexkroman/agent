// Copyright 2025 the AAI authors. MIT license.
/**
 * Vector store interface and in-memory implementation.
 *
 * @module
 */

/**
 * A single vector search result entry.
 */
export type VectorEntry = {
  /** The unique identifier for this entry. */
  id: string;
  /** Similarity score (higher = more similar). */
  score: number;
  /** The original text data stored with this entry. */
  data?: string | undefined;
  /** Arbitrary metadata stored with this entry. */
  metadata?: Record<string, unknown> | undefined;
};

/**
 * Async vector store interface used by agents.
 *
 * Agents access the vector store via {@linkcode ToolContext.vector} or
 * {@linkcode HookContext.vector}. Backed by Upstash Vector with built-in
 * embeddings — raw text is sent and vectorized server-side.
 *
 * @example
 * ```ts
 * // Inside a tool execute function:
 * const myTool = {
 *   description: "Search knowledge base",
 *   execute: async (_args: unknown, ctx: { vector: VectorStore }) => {
 *     await ctx.vector.upsert("doc-1", "The capital of France is Paris.");
 *     const results = await ctx.vector.query("What is the capital of France?");
 *     return results;
 *   },
 * };
 * ```
 */
export type VectorStore = {
  /**
   * Upsert a text entry into the vector store.
   *
   * The text is automatically embedded by the server's vector database.
   *
   * @param id Unique identifier for this entry.
   * @param data The text content to store and embed.
   * @param metadata Optional metadata to store alongside the vector.
   */
  upsert(id: string, data: string, metadata?: Record<string, unknown>): Promise<void>;

  /**
   * Query the vector store with a text string.
   *
   * Returns the most similar entries ranked by score.
   *
   * @param text The query text to search for.
   * @param options Optional query parameters.
   * @param options.topK Maximum number of results (default: 10).
   * @param options.filter Metadata filter expression.
   * @returns An array of matching {@linkcode VectorEntry} objects.
   */
  query(text: string, options?: { topK?: number; filter?: string }): Promise<VectorEntry[]>;

  /**
   * Remove entries by ID.
   *
   * @param ids A single ID or array of IDs to remove.
   */
  remove(ids: string | string[]): Promise<void>;
};

/**
 * Create an in-memory vector store for testing and local development.
 *
 * Uses brute-force substring matching instead of real vector similarity.
 * Good enough for testing the plumbing but not for production use.
 *
 * @returns A {@linkcode VectorStore} instance backed by in-memory storage.
 *
 * @example
 * ```ts
 * import { createMemoryVectorStore } from "aai";
 *
 * const vector = createMemoryVectorStore();
 * await vector.upsert("doc-1", "The capital of France is Paris.");
 * const results = await vector.query("France capital");
 * ```
 */
export function createMemoryVectorStore(): VectorStore {
  const store = new Map<string, { data: string; metadata?: Record<string, unknown> | undefined }>();

  return {
    upsert(id: string, data: string, metadata?: Record<string, unknown>): Promise<void> {
      store.set(id, { data, metadata });
      return Promise.resolve();
    },

    query(text: string, options?: { topK?: number; filter?: string }): Promise<VectorEntry[]> {
      const topK = options?.topK ?? 10;
      const query = text.toLowerCase();
      const results: VectorEntry[] = [];

      for (const [id, entry] of store) {
        const data = entry.data.toLowerCase();
        // Simple substring scoring: count how many query words appear in data
        const words = query.split(/\s+/).filter(Boolean);
        const matches = words.filter((w) => data.includes(w)).length;
        if (matches > 0) {
          results.push({
            id,
            score: matches / Math.max(words.length, 1),
            data: entry.data,
            metadata: entry.metadata,
          });
        }
      }

      results.sort((a, b) => b.score - a.score);
      return Promise.resolve(results.slice(0, topK));
    },

    remove(ids: string | string[]): Promise<void> {
      const idArray = Array.isArray(ids) ? ids : [ids];
      for (const id of idArray) {
        store.delete(id);
      }
      return Promise.resolve();
    },
  };
}
