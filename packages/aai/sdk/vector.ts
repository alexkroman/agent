// Copyright 2026 the AAI authors. MIT license.
/**
 * Vector store interface — semantic search / RAG access for agent tools.
 *
 * Mirrors the {@link Kv} pattern: a small, JSON-friendly interface that the
 * host implements for whatever provider was selected (Pinecone, etc.) and
 * that tools consume via {@link ToolContext.vector}.
 */

/**
 * One record in a vector store.
 *
 * `id` uniquely identifies the record within its namespace; `values` is the
 * embedding vector; `metadata` is free-form JSON associated with the record.
 *
 * @public
 */
export type VectorRecord = {
  id: string;
  values: number[];
  metadata?: Record<string, unknown> | undefined;
};

/**
 * Match returned from {@link Vector.query}.
 *
 * @public
 */
export type VectorMatch = {
  id: string;
  score: number;
  metadata?: Record<string, unknown> | undefined;
  values?: number[] | undefined;
};

/**
 * Query options accepted by {@link Vector.query}.
 *
 * Exactly one of `vector` or `id` must be provided. `topK` defaults to 10.
 *
 * @public
 */
export type VectorQuery = {
  vector?: number[];
  id?: string;
  topK?: number;
  filter?: Record<string, unknown>;
  includeValues?: boolean;
  includeMetadata?: boolean;
  namespace?: string;
};

/**
 * Async vector store interface used by agents.
 *
 * Tools access the vector store via `ToolContext.vector`. Implementations
 * proxy operations to a provider (e.g. Pinecone) over HTTP.
 *
 * @example
 * ```ts
 * // Inside a tool execute function:
 * const matches = await ctx.vector.query({ vector: embedding, topK: 5 });
 * for (const m of matches) console.log(m.id, m.score, m.metadata);
 * ```
 *
 * @public
 */
export type Vector = {
  /**
   * Insert or update one or more records. Records with existing ids are
   * overwritten; new ids are inserted.
   */
  upsert(records: VectorRecord | VectorRecord[], options?: { namespace?: string }): Promise<void>;

  /**
   * Find the nearest neighbours to a query vector or to an existing record's
   * vector (when `id` is supplied).
   */
  query(query: VectorQuery): Promise<VectorMatch[]>;

  /**
   * Delete records by id. Pass `{ deleteAll: true }` to clear the namespace.
   */
  delete(
    ids: string | string[],
    options?: { namespace?: string; deleteAll?: boolean },
  ): Promise<void>;

  /**
   * Fetch records by id. Returns matches in arbitrary order; missing ids are
   * omitted from the result.
   */
  fetch(ids: string | string[], options?: { namespace?: string }): Promise<VectorRecord[]>;
};
