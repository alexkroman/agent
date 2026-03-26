// Copyright 2025 the AAI authors. MIT license.
// KV store backed by @upstash/redis.

import { type KvEntry, MAX_VALUE_SIZE } from "@alexkroman1/aai/kv";
import { Redis } from "@upstash/redis";
import type { AgentScope } from "./scope-token.ts";

export type KvStore = {
  get(scope: AgentScope, key: string): Promise<string | null>;
  set(scope: AgentScope, key: string, value: string, ttl?: number): Promise<void>;
  delete(scope: AgentScope, key: string): Promise<void>;
  keys(scope: AgentScope, pattern?: string): Promise<string[]>;
  list(
    scope: AgentScope,
    prefix: string,
    options?: { limit?: number; reverse?: boolean },
  ): Promise<KvEntry[]>;
};

function scopedKey(scope: AgentScope, key: string): string {
  return `kv:${scope.keyHash}:${scope.slug}:${key}`;
}

function scopePrefix(scope: AgentScope): string {
  return `kv:${scope.keyHash}:${scope.slug}:`;
}

async function scanAll(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const result: [string, string[]] = await redis.scan(cursor, { match: pattern });
    cursor = result[0];
    keys.push(...result[1]);
  } while (cursor !== "0");
  return keys;
}

export function createKvStore(url: string, token: string): KvStore {
  const redis = new Redis({ url, token });

  return {
    async get(scope, key) {
      const result = await redis.get<string>(scopedKey(scope, key));
      return result ?? null;
    },

    async set(scope, key, value, ttl) {
      if (value.length > MAX_VALUE_SIZE) {
        throw new Error(`Value exceeds max size of ${MAX_VALUE_SIZE} bytes`);
      }
      const sk = scopedKey(scope, key);
      if (ttl && ttl > 0) {
        await redis.set(sk, value, { ex: ttl });
      } else {
        await redis.set(sk, value);
      }
    },

    async delete(scope, key) {
      await redis.del(scopedKey(scope, key));
    },

    async keys(scope, pattern) {
      const prefix = scopePrefix(scope);
      const searchPattern = pattern ? `${prefix}${pattern}` : `${prefix}*`;
      const rawKeys = await scanAll(redis, searchPattern);
      return rawKeys.map((k) => k.slice(prefix.length));
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Redis scan + pipeline + parse in one pass
    async list(scope, userPrefix, options) {
      const prefix = scopePrefix(scope);
      const searchPattern = `${prefix}${userPrefix}*`;
      const rawKeys = await scanAll(redis, searchPattern);
      const sorted = rawKeys.sort();
      if (options?.reverse) sorted.reverse();
      const limited = options?.limit && options.limit > 0 ? sorted.slice(0, options.limit) : sorted;

      // Pipeline GET for all keys
      if (limited.length === 0) return [];
      const pipeline = redis.pipeline();
      for (const rk of limited) {
        pipeline.get(rk);
      }
      const values = await pipeline.exec<(string | null)[]>();

      const entries: KvEntry[] = [];
      for (let i = 0; i < limited.length; i++) {
        const val = values[i];
        if (val === null || val === undefined) continue;
        // biome-ignore lint/style/noNonNullAssertion: index in bounds from loop
        const key = limited[i]!.slice(prefix.length);
        try {
          entries.push({ key, value: JSON.parse(val) });
        } catch {
          entries.push({ key, value: val });
        }
      }
      return entries;
    },
  };
}
