// Copyright 2025 the AAI authors. MIT license.
/**
 * Backing store for the platform-default KV (`ctx.kv`, the remember/recall
 * builtins, and the owner HTTP KV routes).
 *
 * When Upstash Redis credentials are configured, the default KV runs on
 * Redis instead of the S3 bundle bucket. Redis fits this data class where
 * S3 fights it on three fronts:
 *
 * - **Latency.** Every KV op happens inside a voice turn (tool calls sit on
 *   the speech path), where an S3 round trip is tens of ms and Redis on the
 *   Fly private network is ~1ms.
 * - **TTL.** `createUnstorageKv` passes `ttl` to the driver, which only the
 *   Redis drivers honor server-side (`EX`); on S3 the expiry envelope is
 *   enforced lazily on read, so expired session notes accumulate until an
 *   agent delete sweeps them.
 * - **Lifecycle.** KV data no longer lives under the `agents/{slug}` bundle
 *   prefix in the bucket, so a redeploy's prefix sweep cannot touch it.
 *
 * The key namespace is `agentKvPrefix(slug)` on both backends — one source
 * of truth, and `wipeAgentKv` works identically against either.
 *
 * BYO providers (`kv: redisKv()` etc.) are unaffected: they resolve from the
 * agent's own env in `resolveAgentKv` and never reach this store.
 */

import { createStorage, type Storage } from "unstorage";
import upstashDriver from "unstorage/drivers/upstash";
import { agentKvPrefix } from "./constants.ts";

/** Env vars holding the Upstash Redis REST credentials (Fly Upstash Redis). */
export const UPSTASH_URL_ENV = "UPSTASH_REDIS_REST_URL";
export const UPSTASH_TOKEN_ENV = "UPSTASH_REDIS_REST_TOKEN";

/**
 * Upstash-backed unstorage `Storage` for the platform-default KV, or `null`
 * when the credentials are not configured (callers fall back to the bundle
 * bucket). Requires BOTH env vars — a URL without a token would fail on the
 * first op with an auth error far from the misconfiguration.
 */
export function createUpstashKvStorage(env: NodeJS.ProcessEnv): Storage | null {
  const url = env[UPSTASH_URL_ENV];
  const token = env[UPSTASH_TOKEN_ENV];
  if (!(url && token)) return null;
  return createStorage({ driver: upstashDriver({ url, token }) });
}

/**
 * Remove every platform-default KV key belonging to one agent. Called on
 * agent delete — redeploys deliberately do NOT call this (KV survives a
 * redeploy; see bundle-store.ts `putAgent`). A no-op when the agent has no
 * KV data, including when `kvStorage` is the bundle bucket and
 * `deleteAgent`'s prefix sweep already removed the keys.
 */
export async function wipeAgentKv(kvStorage: Storage, slug: string): Promise<void> {
  const keys = await kvStorage.getKeys(agentKvPrefix(slug));
  await Promise.all(keys.map((key) => kvStorage.removeItem(key)));
}
