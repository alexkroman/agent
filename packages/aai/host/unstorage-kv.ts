// Copyright 2025 the AAI authors. MIT license.

import { prefixStorage, type Storage, type StorageValue } from "unstorage";
import { MAX_VALUE_SIZE } from "../sdk/constants.ts";
import type { Kv } from "../sdk/kv.ts";

type UnstorageKvOptions = {
  storage: Storage;
  prefix?: string;
};

export function createUnstorageKv(options: UnstorageKvOptions): Kv {
  const store = options.prefix ? prefixStorage(options.storage, options.prefix) : options.storage;

  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const value = await store.getItem<T>(key);
      return value ?? null;
    },

    async set(key: string, value: unknown, setOptions?: { expireIn?: number }): Promise<void> {
      // Serialize once: the size check and the stored representation share the
      // same JSON string (unstorage round-trips it back via destr on get).
      const json = JSON.stringify(value);
      if (json.length > MAX_VALUE_SIZE) {
        throw new Error(`Value exceeds max size of ${MAX_VALUE_SIZE} bytes`);
      }
      const expireIn = setOptions?.expireIn;
      const ttlOption = expireIn && expireIn > 0 ? { ttl: Math.ceil(expireIn / 1000) } : undefined;
      await store.setItem(key, json as StorageValue, ttlOption);
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
