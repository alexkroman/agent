// Copyright 2025 the AAI authors. MIT license.
/**
 * Key-value store backed by unstorage.
 *
 * Works with any unstorage driver (memory, fs, S3/R2, etc.).
 */

import { prefixStorage, type Storage } from "unstorage";
import { MAX_VALUE_SIZE } from "../sdk/constants.ts";
import type { Kv } from "../sdk/kv.ts";

/**
 * Options for creating an unstorage-backed KV store.
 */
export type UnstorageKvOptions = {
  /** Configured unstorage Storage instance. */
  storage: Storage;
  /** Key prefix prepended to all operations (e.g. `"agents/my-agent/kv"`). */
  prefix?: string;
};

/**
 * Create a KV store backed by any unstorage driver.
 *
 * @param options - See {@link UnstorageKvOptions}.
 * @returns A {@link Kv} instance.
 *
 * @example
 * ```ts
 * import { createStorage } from "unstorage";
 * import { createUnstorageKv } from "@alexkroman1/aai-core/unstorage-kv";
 *
 * const kv = createUnstorageKv({ storage: createStorage() });
 * await kv.set("greeting", "hello");
 * const value = await kv.get<string>("greeting"); // "hello"
 * ```
 */
export function createUnstorageKv(options: UnstorageKvOptions): Kv {
  const store = options.prefix ? prefixStorage(options.storage, options.prefix) : options.storage;

  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const value = await store.getItem<T>(key);
      return value ?? null;
    },

    async set(key: string, value: unknown, setOptions?: { expireIn?: number }): Promise<void> {
      const serialized = JSON.stringify(value);
      if (serialized.length > MAX_VALUE_SIZE) {
        throw new Error(`Value exceeds max size of ${MAX_VALUE_SIZE} bytes`);
      }
      const storable = value as import("unstorage").StorageValue;
      if (setOptions?.expireIn && setOptions.expireIn > 0) {
        await store.setItem(key, storable, { ttl: Math.ceil(setOptions.expireIn / 1000) });
      } else {
        await store.setItem(key, storable);
      }
    },

    async delete(keys: string | string[]): Promise<void> {
      const keyArray = Array.isArray(keys) ? keys : [keys];
      await Promise.all(keyArray.map((k) => store.removeItem(k)));
    },

    close() {
      void store.dispose();
    },
  };
}
