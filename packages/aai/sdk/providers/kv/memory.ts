// Copyright 2026 the AAI authors. MIT license.
/**
 * In-memory KV factory — returns a pure descriptor.
 *
 * The default for `aai dev` and tests. State lives only for the lifetime of
 * the runtime process and is wiped on restart. The host-side resolver in
 * `host/providers/resolve.ts` constructs an in-memory unstorage instance.
 */

import type { KvProvider } from "../../providers.ts";

export const MEMORY_KV_KIND = "memory" as const;

export interface MemoryKvOptions {
  /** Optional key prefix prepended to all operations. */
  prefix?: string;
}

export type MemoryKvProvider = KvProvider & {
  readonly kind: typeof MEMORY_KV_KIND;
  readonly options: MemoryKvOptions;
};

export function memory(opts: MemoryKvOptions = {}): MemoryKvProvider {
  return { kind: MEMORY_KV_KIND, options: { ...opts } };
}
