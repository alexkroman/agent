// Copyright 2026 the AAI authors. MIT license.
/**
 * Upstash Redis KV opener — REST API via `unstorage/drivers/upstash`.
 *
 * Reads URL/token from descriptor options, falling back to the agent env
 * (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`).
 *
 * The unstorage driver is `require`d lazily at open-time. Loading it at the
 * top level would transitively pull in `@upstash/redis`, breaking host
 * bundles that don't ship that package.
 */

import { createRequire } from "node:module";
import { createStorage } from "unstorage";
import type { Kv } from "../../../sdk/kv.ts";
import type { UpstashKvOptions } from "../../../sdk/providers/kv/upstash.ts";
import { createUnstorageKv } from "../../unstorage-kv.ts";
import { resolveApiKey } from "../_api-key.ts";

const requireFn = createRequire(import.meta.url);

export function openUpstashKv(opts: UpstashKvOptions, env: Record<string, string>): Kv {
  const url = opts.url ?? resolveApiKey("UPSTASH_REDIS_REST_URL", env);
  const token = opts.token ?? resolveApiKey("UPSTASH_REDIS_REST_TOKEN", env);
  if (!(url && token)) {
    throw new Error(
      "Upstash KV: missing URL or token. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, or pass them to upstash({ url, token }).",
    );
  }
  const driverModule = requireFn("unstorage/drivers/upstash") as {
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
