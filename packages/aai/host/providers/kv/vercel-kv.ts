// Copyright 2026 the AAI authors. MIT license.
/**
 * Vercel KV opener — `unstorage/drivers/vercel-kv`.
 *
 * The driver is `require`d lazily at open-time so the host bundle does not
 * pull in `@vercel/kv` for agents that aren't using it.
 */

import { createRequire } from "node:module";
import { createStorage } from "unstorage";
import type { Kv } from "../../../sdk/kv.ts";
import type { VercelKvOptions } from "../../../sdk/providers/kv/vercel-kv.ts";
import { createUnstorageKv } from "../../unstorage-kv.ts";
import { resolveApiKey } from "../_api-key.ts";

const requireFn = createRequire(import.meta.url);

export function openVercelKv(opts: VercelKvOptions, env: Record<string, string>): Kv {
  const url = opts.url ?? resolveApiKey("KV_REST_API_URL", env);
  const token = opts.token ?? resolveApiKey("KV_REST_API_TOKEN", env);
  if (!(url && token)) {
    throw new Error(
      "Vercel KV: missing URL or token. Set KV_REST_API_URL and KV_REST_API_TOKEN, or pass them to vercelKV({ url, token }).",
    );
  }
  const driverModule = requireFn("unstorage/drivers/vercel-kv") as {
    default: (opts: { url: string; token: string }) => unknown;
  };
  // biome-ignore lint/suspicious/noExplicitAny: any unstorage driver shape
  const driver = driverModule.default({ url, token }) as any;
  const storage = createStorage({ driver });
  return createUnstorageKv({
    storage,
    ...(opts.prefix ? { prefix: opts.prefix } : {}),
  });
}
