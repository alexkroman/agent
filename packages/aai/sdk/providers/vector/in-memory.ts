// Copyright 2025 the AAI authors. MIT license.
/**
 * In-memory Vector descriptor.
 *
 * Resolves to a process-local store with deterministic hash-based
 * pseudo-embeddings. Quality is intentionally bad — the purpose is
 * proving tool wiring during `aai dev`, not retrieval ranking.
 */

import type { VectorProvider } from "../../providers.ts";

export const IN_MEMORY_VECTOR_KIND = "in-memory" as const;

export type InMemoryVectorOptions = Record<string, never>;

export type InMemoryVectorProvider = VectorProvider & {
  readonly kind: typeof IN_MEMORY_VECTOR_KIND;
  readonly options: InMemoryVectorOptions;
};

export function inMemoryVector(): InMemoryVectorProvider {
  return { kind: IN_MEMORY_VECTOR_KIND, options: {} };
}
