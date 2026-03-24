// Copyright 2025 the AAI authors. MIT license.
/**
 * Custom binding interfaces that mirror Cloudflare Workers bindings.
 *
 * These provide the same API surface as CF KV, R2, and Vectorize but are
 * backed by external services (Upstash, Tigris) via fetch(). This allows
 * the server to use CF-shaped APIs while running on Fly.io, and makes
 * migration to real CF bindings trivial.
 *
 * @module
 */

// ─── KV Namespace ─────────────────────────────────────────────────────────────
// Mirrors Cloudflare Workers KV (KVNamespace)

export type AaiKvNamespace = {
  get(key: string, options?: { type?: "text" }): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number }): Promise<AaiKvListResult>;
};

export type AaiKvListResult = {
  keys: { name: string }[];
  list_complete: boolean;
};

// ─── R2 Bucket ────────────────────────────────────────────────────────────────
// Mirrors Cloudflare R2 (R2Bucket)

export type AaiR2Object = {
  key: string;
  body: ReadableStream | null;
  text(): Promise<string>;
  etag: string;
};

export type AaiR2Bucket = {
  get(
    key: string,
    options?: { onlyIf?: { etagDoesNotMatch?: string } },
  ): Promise<AaiR2Object | null>;
  put(
    key: string,
    value: string | ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<AaiR2Object>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; limit?: number }): Promise<AaiR2ListResult>;
};

export type AaiR2ListResult = {
  objects: { key: string; etag: string }[];
  truncated: boolean;
};

// ─── Vectorize Index ──────────────────────────────────────────────────────────
// Mirrors Cloudflare Vectorize (VectorizeIndex)

export type AaiVectorizeMatch = {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
};

export type AaiVectorizeIndex = {
  upsert(
    vectors: { id: string; values?: number[]; metadata?: Record<string, unknown> }[],
  ): Promise<{ count: number }>;
  query(
    queryVector: number[] | string,
    options?: { topK?: number; filter?: Record<string, unknown>; returnMetadata?: boolean },
  ): Promise<{ matches: AaiVectorizeMatch[] }>;
  deleteByIds(ids: string[]): Promise<{ count: number }>;
};

// ─── WebSocket Pair ───────────────────────────────────────────────────────────
// workerd natively provides WebSocketPair; this re-exports the type for
// consistent binding access.

export type AaiWebSocketPair = {
  /** The client-side WebSocket (returned in the Response). */
  0: WebSocket;
  /** The server-side WebSocket (used by the handler). */
  1: WebSocket;
};
