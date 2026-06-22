// Copyright 2025 the AAI authors. MIT license.

/** @public */
export type VectorMetadata = Record<string, unknown>;

/**
 * Backend-specific filter expression. Pinecone uses MongoDB-like operators;
 * other backends may use a different query DSL.
 * @public
 */
export type VectorFilter = Record<string, unknown>;

/** @public */
export type VectorMatch = {
  id: string;
  score: number;
  text: string;
  metadata?: VectorMetadata;
};

/** @public */
export type VectorQueryOptions = {
  /** Number of results to return. Default 5, max 100. */
  topK?: number;
  /** Backend-specific filter expression. */
  filter?: VectorFilter;
};

/**
 * Vector storage interface used by agents.
 *
 * Agents access the store via `ctx.vector`. Backends embed text on
 * write and run similarity search on read; the interface is text-in,
 * matches-out so users never deal with embedding vectors directly.
 *
 * @public
 */
export type Vector = {
  upsert(id: string, text: string, metadata?: VectorMetadata): Promise<void>;
  query(text: string, opts?: VectorQueryOptions): Promise<VectorMatch[]>;
  delete(ids: string | string[]): Promise<void>;
  close?(): void;
};
