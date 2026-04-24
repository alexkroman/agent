// Copyright 2026 the AAI authors. MIT license.
/**
 * Generic unstorage KV opener — dynamically imports any
 * `unstorage/drivers/<driver>` and instantiates it with the supplied options.
 *
 * Synchronous: uses a `require`-based import so the runtime does not need
 * to await a dynamic import in its hot path. Falls back to a clearer error
 * if the driver path does not resolve.
 */

import { createRequire } from "node:module";
import { createStorage } from "unstorage";
import type { Kv } from "../../../sdk/kv.ts";
import type { UnstorageKvDescriptorOptions } from "../../../sdk/providers/kv/unstorage.ts";
import { createUnstorageKv } from "../../unstorage-kv.ts";

const requireFn = createRequire(import.meta.url);

export function openUnstorageKv(opts: UnstorageKvDescriptorOptions): Kv {
  const driverModulePath = `unstorage/drivers/${opts.driver}`;
  let driverFactory: (config: unknown) => unknown;
  try {
    const mod = requireFn(driverModulePath) as { default?: unknown };
    const candidate = (mod.default ?? mod) as unknown;
    if (typeof candidate !== "function") {
      throw new Error(`unstorage driver "${opts.driver}" does not export a factory function`);
    }
    driverFactory = candidate as (config: unknown) => unknown;
  } catch (err) {
    throw new Error(
      `Failed to load unstorage driver "${opts.driver}" from ${driverModulePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  const storage = createStorage({
    // biome-ignore lint/suspicious/noExplicitAny: any unstorage driver shape
    driver: driverFactory(opts.options ?? {}) as any,
  });
  return createUnstorageKv({
    storage,
    ...(opts.prefix ? { prefix: opts.prefix } : {}),
  });
}
