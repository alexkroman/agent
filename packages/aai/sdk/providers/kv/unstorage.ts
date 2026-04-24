// Copyright 2026 the AAI authors. MIT license.
/**
 * Generic unstorage KV factory — returns a pure descriptor.
 *
 * Power-user escape hatch for any unstorage driver beyond the curated
 * `memory` / `upstash` / `vercelKV` / `cloudflareKV` factories. The host
 * dynamically imports `unstorage/drivers/<driver>` and instantiates it with
 * the supplied options.
 *
 * **Sandbox compatibility note:** drivers that open raw TCP sockets (real
 * Redis, Postgres) or touch the filesystem will not work inside the gVisor
 * sandbox — only the host fetch proxy is available. HTTP-based drivers
 * (`http`, `upstash`, `vercel-kv`, `cloudflare-kv-http`, `azure-cosmos`,
 * `github`, etc.) work as expected.
 *
 * Driver hosts not auto-allowlisted by the curated factories must be added
 * to `allowedHosts` in `agent({ allowedHosts: [...] })`.
 *
 * @example
 * ```ts
 * import { unstorage } from "@alexkroman1/aai/kv";
 *
 * export default agent({
 *   kv: unstorage({
 *     driver: "azure-cosmos",
 *     options: { endpoint: process.env.AZURE_COSMOS_ENDPOINT },
 *   }),
 * });
 * ```
 */

import type { KvProvider } from "../../providers.ts";

export const UNSTORAGE_KV_KIND = "unstorage" as const;

export interface UnstorageKvDescriptorOptions {
  /**
   * Driver name as exported by `unstorage/drivers/<name>`.
   * E.g. `"http"`, `"upstash"`, `"vercel-kv"`, `"cloudflare-kv-http"`.
   */
  driver: string;
  /** Driver-specific options forwarded verbatim. */
  options?: Record<string, unknown>;
  /** Key prefix prepended to all operations. */
  prefix?: string;
}

export type UnstorageKvProvider = KvProvider & {
  readonly kind: typeof UNSTORAGE_KV_KIND;
  readonly options: UnstorageKvDescriptorOptions;
};

export function unstorage(opts: UnstorageKvDescriptorOptions): UnstorageKvProvider {
  return {
    kind: UNSTORAGE_KV_KIND,
    options: {
      driver: opts.driver,
      options: opts.options ?? {},
      ...(opts.prefix !== undefined ? { prefix: opts.prefix } : {}),
    },
  };
}
