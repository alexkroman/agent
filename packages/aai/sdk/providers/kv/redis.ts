// Copyright 2025 the AAI authors. MIT license.
/**
 * Redis KV descriptor.
 *
 * Resolves to unstorage's `redis` driver. Connection URL is pulled
 * from the agent env (`REDIS_URL`) at session start.
 */

import type { KvProvider } from "../../providers.ts";

export const REDIS_KV_KIND = "redis" as const;

/** Agent env var holding the Redis connection URL the resolver reads at session start. */
export const REDIS_KV_URL_ENV = "REDIS_URL";

export interface RedisKvOptions {
  /** Force TLS. Defaults to inferring from `rediss://` URL scheme. */
  tls?: boolean;
}

export type RedisKvProvider = KvProvider & {
  readonly kind: typeof REDIS_KV_KIND;
  readonly options: RedisKvOptions;
};

export function redisKv(opts: RedisKvOptions = {}): RedisKvProvider {
  return { kind: REDIS_KV_KIND, options: { ...opts } };
}
