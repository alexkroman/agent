// Copyright 2025 the AAI authors. MIT license.
/** In-memory Vector descriptor — process-local store for `aai dev`. */

import type { VectorProvider } from "../../providers.ts";

export const IN_MEMORY_VECTOR_KIND = "in-memory" as const;

export type InMemoryVectorProvider = VectorProvider & {
  readonly kind: typeof IN_MEMORY_VECTOR_KIND;
  readonly options: Record<string, never>;
};

const IN_MEMORY_VECTOR: InMemoryVectorProvider = {
  kind: IN_MEMORY_VECTOR_KIND,
  options: {},
};

export function inMemoryVector(): InMemoryVectorProvider {
  return IN_MEMORY_VECTOR;
}
