// Copyright 2025 the AAI authors. MIT license.
/** In-memory KV descriptor — unstorage default driver. */

import type { KvProvider } from "../../providers.ts";

export const MEMORY_KV_KIND = "memory" as const;

export type MemoryKvOptions = Record<string, never>;

export type MemoryKvProvider = KvProvider & {
  readonly kind: typeof MEMORY_KV_KIND;
  readonly options: MemoryKvOptions;
};

export function memoryKv(): MemoryKvProvider {
  return { kind: MEMORY_KV_KIND, options: {} };
}
