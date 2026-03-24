// Copyright 2025 the AAI authors. MIT license.
/**
 * AaiKvNamespace implementation backed by @upstash/redis.
 *
 * @module
 */

import { Redis } from "@upstash/redis";
import type { AaiKvListResult, AaiKvNamespace } from "./bindings.ts";

export type KvConfig = {
  url: string;
  token: string;
};

export function createKvBinding(config: KvConfig): AaiKvNamespace {
  const redis = new Redis({ url: config.url, token: config.token });

  return {
    async get(key) {
      const result = await redis.get<string>(key);
      return result ?? null;
    },

    async put(key, value, options) {
      if (options?.expirationTtl && options.expirationTtl > 0) {
        await redis.set(key, value, { ex: options.expirationTtl });
      } else {
        await redis.set(key, value);
      }
    },

    async delete(key) {
      await redis.del(key);
    },

    async list(options) {
      const pattern = options?.prefix ? `${options.prefix}*` : "*";
      const keys: string[] = [];
      let cursor = "0";
      do {
        const args: { match: string; count?: number } = { match: pattern };
        if (options?.limit) args.count = options.limit;
        const result: [string, string[]] = await redis.scan(cursor, args);
        cursor = result[0];
        keys.push(...result[1]);
      } while (cursor !== "0");

      const limited = options?.limit ? keys.slice(0, options.limit) : keys;
      const result: AaiKvListResult = {
        keys: limited.map((name) => ({ name })),
        list_complete: limited.length === keys.length,
      };
      return result;
    },
  };
}
