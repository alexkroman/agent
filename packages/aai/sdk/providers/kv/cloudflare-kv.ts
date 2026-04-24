// Copyright 2026 the AAI authors. MIT license.
/**
 * Cloudflare KV factory — returns a pure descriptor.
 *
 * Backed by `unstorage/drivers/cloudflare-kv-http`, which talks to
 * Cloudflare's REST API. Suitable for the gVisor sandbox path because the
 * driver only uses fetch.
 */

import type { KvProvider } from "../../providers.ts";

export const CLOUDFLARE_KV_KIND = "cloudflare-kv" as const;

export interface CloudflareKvOptions {
  /** Cloudflare account id. Defaults to `process.env.CLOUDFLARE_ACCOUNT_ID`. */
  accountId?: string;
  /** Cloudflare KV namespace id. Defaults to `process.env.CLOUDFLARE_KV_NAMESPACE_ID`. */
  namespaceId?: string;
  /** Cloudflare API token. Defaults to `process.env.CLOUDFLARE_API_TOKEN`. */
  apiToken?: string;
  /** Key prefix prepended to all operations. */
  prefix?: string;
}

export type CloudflareKvProvider = KvProvider & {
  readonly kind: typeof CLOUDFLARE_KV_KIND;
  readonly options: CloudflareKvOptions;
};

export function cloudflareKV(opts: CloudflareKvOptions = {}): CloudflareKvProvider {
  return { kind: CLOUDFLARE_KV_KIND, options: { ...opts } };
}
