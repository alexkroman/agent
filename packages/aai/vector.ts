// Copyright 2025 the AAI authors. MIT license.
/**
 * Vector store interface and in-memory implementation.
 */

/**
 * A single vector search result entry.
 *
 * @public
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
 * Agents access the vector store via `ToolContext.vector` or
 * `HookContext.vector`. Backed by Upstash Vector with built-in
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
 *
 * @public
 */
export type VectorStore = {
  /**
   * Upsert a text entry into the vector store.
   *
   * The text is automatically embedded by the server's vector database.
   *
   * @param id - Unique identifier for this entry.
   * @param data - The text content to store and embed.
   * @param metadata - Optional metadata to store alongside the vector.
   */
  upsert(id: string, data: string, metadata?: Record<string, unknown>): Promise<void>;

  /**
   * Query the vector store with a text string.
   *
   * Returns the most similar entries ranked by score.
   *
   * @param text - The query text to search for.
   * @param options - Optional query parameters. `topK` sets the maximum number of results (default: 10). `filter` is a metadata filter expression.
   * @returns An array of matching {@link VectorEntry} objects.
   */
  query(text: string, options?: { topK?: number; filter?: string }): Promise<VectorEntry[]>;

  /**
   * Remove entries by ID.
   *
   * @param ids - A single ID or array of IDs to remove.
   */
  remove(ids: string | string[]): Promise<void>;
};

/**
 * Create an in-memory vector store for testing and local development.
 *
 * Uses brute-force substring matching instead of real vector similarity.
 * Good enough for testing the plumbing but not for production use.
 *
 * @returns A {@link VectorStore} instance backed by in-memory storage.
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

    async query(
      text: string,
      options?: { topK?: number; filter?: string },
    ): Promise<VectorEntry[]> {
      const topK = options?.topK ?? 10;
      const query = text.toLowerCase();
      const words = query.split(/\s+/).filter(Boolean);
      const results: VectorEntry[] = [];

      let i = 0;
      for (const [id, entry] of store) {
        if (++i % 500 === 0) await new Promise<void>((r) => setTimeout(r, 0));
        const data = entry.data.toLowerCase();
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
      return results.slice(0, topK);
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
