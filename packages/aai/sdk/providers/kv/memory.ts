// Copyright 2025 the AAI authors. MIT license.
/** In-memory KV descriptor — unstorage default driver. */

import type { KvProvider } from "../../providers.ts";

export const MEMORY_KV_KIND = "memory" as const;

export type MemoryKvProvider = KvProvider & {
  readonly kind: typeof MEMORY_KV_KIND;
  readonly options: Record<string, never>;
};

const MEMORY_KV: MemoryKvProvider = { kind: MEMORY_KV_KIND, options: {} };

export function memoryKv(): MemoryKvProvider {
  return MEMORY_KV;
}
