// Copyright 2026 the AAI authors. MIT license.
/**
 * Vercel KV factory — returns a pure descriptor.
 *
 * Vercel KV is an Upstash-backed Redis service exposed via REST. The
 * host-side resolver reads `KV_REST_API_URL` / `KV_REST_API_TOKEN` from the
 * agent's env unless overridden, and uses `unstorage/drivers/vercel-kv`.
 */

import type { KvProvider } from "../../providers.ts";

export const VERCEL_KV_KIND = "vercel-kv" as const;

export interface VercelKvOptions {
  /** Vercel KV REST URL. Defaults to `process.env.KV_REST_API_URL`. */
  url?: string;
  /** Vercel KV REST token. Defaults to `process.env.KV_REST_API_TOKEN`. */
  token?: string;
  /** Key prefix prepended to all operations. */
  prefix?: string;
}

export type VercelKvProvider = KvProvider & {
  readonly kind: typeof VERCEL_KV_KIND;
  readonly options: VercelKvOptions;
};

export function vercelKV(opts: VercelKvOptions = {}): VercelKvProvider {
  return { kind: VERCEL_KV_KIND, options: { ...opts } };
}
