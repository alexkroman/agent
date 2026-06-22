// Copyright 2025 the AAI authors. MIT license.

import { prefixStorage, type Storage, type StorageValue } from "unstorage";
import { MAX_VALUE_SIZE } from "../sdk/constants.ts";
import type { Kv } from "../sdk/kv.ts";

export type UnstorageKvOptions = {
  storage: Storage;
  prefix?: string;
};

export function createUnstorageKv(options: UnstorageKvOptions): Kv {
  const store = options.prefix ? prefixStorage(options.storage, options.prefix) : options.storage;

  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      return (await store.getItem<T>(key)) ?? null;
    },

    async set(key: string, value: unknown, setOptions?: { expireIn?: number }): Promise<void> {
      if (JSON.stringify(value).length > MAX_VALUE_SIZE) {
        throw new Error(`Value exceeds max size of ${MAX_VALUE_SIZE} bytes`);
      }
      const ttlOption =
        setOptions?.expireIn && setOptions.expireIn > 0
          ? { ttl: Math.ceil(setOptions.expireIn / 1000) }
          : undefined;
      await store.setItem(key, value as StorageValue, ttlOption);
    },

    async delete(keys: string | string[]): Promise<void> {
      if (typeof keys === "string") {
        await store.removeItem(keys);
        return;
      }
      await Promise.all(keys.map((k) => store.removeItem(k)));
    },

    close() {
      void store.dispose();
    },
  };
}
