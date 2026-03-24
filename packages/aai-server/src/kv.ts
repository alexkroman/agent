// Copyright 2025 the AAI authors. MIT license.
// KV store backed by Upstash Redis REST API using raw fetch().

import { MAX_VALUE_SIZE } from "@alexkroman1/aai/kv";
import type { AgentScope } from "./scope_token.ts";

export type KvListEntry = { key: string; value: unknown };

export type KvStore = {
  get(scope: AgentScope, key: string): Promise<string | null>;
  set(scope: AgentScope, key: string, value: string, ttl?: number): Promise<void>;
  del(scope: AgentScope, key: string): Promise<void>;
  keys(scope: AgentScope, pattern?: string): Promise<string[]>;
  list(
    scope: AgentScope,
    prefix: string,
    options?: { limit?: number; reverse?: boolean },
  ): Promise<KvListEntry[]>;
};

function scopedKey(scope: AgentScope, key: string): string {
  return `kv:${scope.keyHash}:${scope.slug}:${key}`;
}

function scopePrefix(scope: AgentScope): string {
  return `kv:${scope.keyHash}:${scope.slug}:`;
}

type RedisResponse = { result: unknown; error?: string };

async function redisCmd(url: string, token: string, args: string[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Upstash Redis error: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as RedisResponse;
  if (body.error) throw new Error(`Upstash Redis: ${body.error}`);
  return body.result;
}

async function scanAll(url: string, token: string, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const result = (await redisCmd(url, token, ["SCAN", cursor, "MATCH", pattern])) as [
      string,
      string[],
    ];
    cursor = String(result[0]);
    keys.push(...result[1]);
  } while (cursor !== "0");
  return keys;
}

export function createKvStore(url: string, token: string): KvStore {
  return {
    async get(scope, key) {
      const result = await redisCmd(url, token, ["GET", scopedKey(scope, key)]);
      return (result as string) ?? null;
    },

    async set(scope, key, value, ttl) {
      if (value.length > MAX_VALUE_SIZE) {
        throw new Error(`Value exceeds max size of ${MAX_VALUE_SIZE} bytes`);
      }
      const args = ["SET", scopedKey(scope, key), value];
      if (ttl && ttl > 0) {
        args.push("EX", String(ttl));
      }
      await redisCmd(url, token, args);
    },

    async del(scope, key) {
      await redisCmd(url, token, ["DEL", scopedKey(scope, key)]);
    },

    async keys(scope, pattern) {
      const prefix = scopePrefix(scope);
      const searchPattern = pattern ? `${prefix}${pattern}` : `${prefix}*`;
      const rawKeys = await scanAll(url, token, searchPattern);
      return rawKeys.map((k) => k.slice(prefix.length));
    },

    async list(scope, userPrefix, options) {
      const prefix = scopePrefix(scope);
      const searchPattern = `${prefix}${userPrefix}*`;
      const rawKeys = await scanAll(url, token, searchPattern);
      const sorted = rawKeys.sort();
      if (options?.reverse) sorted.reverse();
      const limited = options?.limit && options.limit > 0 ? sorted.slice(0, options.limit) : sorted;

      // Pipeline GET for all keys
      const values = await Promise.all(
        limited.map((rk) => redisCmd(url, token, ["GET", rk]) as Promise<string | null>),
      );

      const entries: KvListEntry[] = [];
      for (let i = 0; i < limited.length; i++) {
        const val = values[i];
        if (val === null || val === undefined) continue;
        // biome-ignore lint/style/noNonNullAssertion: index in bounds from loop
        const key = limited[i]!.slice(prefix.length);
        try {
          entries.push({ key, value: JSON.parse(val as string) });
        } catch {
          entries.push({ key, value: val });
        }
      }
      return entries;
    },
  };
}
