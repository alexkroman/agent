// Copyright 2026 the AAI authors. MIT license.
/**
 * Cloudflare KV opener — `unstorage/drivers/cloudflare-kv-http`.
 *
 * The driver is `require`d lazily at open-time so the host bundle does not
 * pull in Cloudflare-specific peer deps for agents that aren't using it.
 */

import { createRequire } from "node:module";
import { createStorage } from "unstorage";
import type { Kv } from "../../../sdk/kv.ts";
import type { CloudflareKvOptions } from "../../../sdk/providers/kv/cloudflare-kv.ts";
import { createUnstorageKv } from "../../unstorage-kv.ts";
import { resolveApiKey } from "../_api-key.ts";

const requireFn = createRequire(import.meta.url);

export function openCloudflareKv(opts: CloudflareKvOptions, env: Record<string, string>): Kv {
  const accountId = opts.accountId ?? resolveApiKey("CLOUDFLARE_ACCOUNT_ID", env);
  const namespaceId = opts.namespaceId ?? resolveApiKey("CLOUDFLARE_KV_NAMESPACE_ID", env);
  const apiToken = opts.apiToken ?? resolveApiKey("CLOUDFLARE_API_TOKEN", env);
  if (!(accountId && namespaceId && apiToken)) {
    throw new Error(
      "Cloudflare KV: missing accountId, namespaceId, or apiToken. " +
        "Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_KV_NAMESPACE_ID, CLOUDFLARE_API_TOKEN, or pass them to cloudflareKV({...}).",
    );
  }
  const driverModule = requireFn("unstorage/drivers/cloudflare-kv-http") as {
    default: (opts: { accountId: string; namespaceId: string; apiToken: string }) => unknown;
  };
  // biome-ignore lint/suspicious/noExplicitAny: any unstorage driver shape
  const driver = driverModule.default({ accountId, namespaceId, apiToken }) as any;
  const storage = createStorage({ driver });
  return createUnstorageKv({
    storage,
    ...(opts.prefix ? { prefix: opts.prefix } : {}),
  });
}
