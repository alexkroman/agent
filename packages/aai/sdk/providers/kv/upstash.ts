// Copyright 2026 the AAI authors. MIT license.
/**
 * Upstash Redis KV factory — returns a pure descriptor.
 *
 * Uses Upstash's HTTPS REST API, which works inside the gVisor sandbox via
 * the host's fetch proxy. The host-side resolver picks the URL/token from
 * the agent's env (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`)
 * unless overridden in options. The resolver also adds the configured URL's
 * host to the sandbox `allowedHosts` automatically.
 */

import type { KvProvider } from "../../providers.ts";

export const UPSTASH_KV_KIND = "upstash" as const;

export interface UpstashKvOptions {
  /** Upstash REST URL. Defaults to `process.env.UPSTASH_REDIS_REST_URL`. */
  url?: string;
  /** Upstash REST token. Defaults to `process.env.UPSTASH_REDIS_REST_TOKEN`. */
  token?: string;
  /** Key prefix prepended to all operations. */
  prefix?: string;
}

export type UpstashKvProvider = KvProvider & {
  readonly kind: typeof UPSTASH_KV_KIND;
  readonly options: UpstashKvOptions;
};

export function upstash(opts: UpstashKvOptions = {}): UpstashKvProvider {
  return { kind: UPSTASH_KV_KIND, options: { ...opts } };
}
