// Copyright 2026 the AAI authors. MIT license.
/**
 * In-memory KV opener — backed by unstorage's default memory driver.
 */

import { createStorage } from "unstorage";
import type { Kv } from "../../../sdk/kv.ts";
import type { MemoryKvOptions } from "../../../sdk/providers/kv/memory.ts";
import { createUnstorageKv } from "../../unstorage-kv.ts";

export function openMemoryKv(opts: MemoryKvOptions): Kv {
  return createUnstorageKv({
    storage: createStorage(),
    ...(opts.prefix ? { prefix: opts.prefix } : {}),
  });
}
