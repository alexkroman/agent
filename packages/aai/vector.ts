// Copyright 2025 the AAI authors. MIT license.
/**
 * Vector store interface.
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
   * Delete entries by ID.
   *
   * @param ids - A single ID or array of IDs to delete.
   */
  delete(ids: string | string[]): Promise<void>;
};
