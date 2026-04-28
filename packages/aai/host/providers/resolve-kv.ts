// Copyright 2025 the AAI authors. MIT license.
/**
 * Descriptor → concrete `Kv` resolver. Mirror of `resolveLlm` /
 * `resolveVector`. Always wraps the produced unstorage Storage in
 * `createUnstorageKv` with the provided per-tenant prefix so namespace
 * isolation is enforced regardless of backend choice.
 */

import { createRequire } from "node:module";
import { createStorage, type Driver } from "unstorage";
import type { Kv } from "../../sdk/kv.ts";
import { FS_KV_KIND, type FsKvOptions } from "../../sdk/providers/kv/fs.ts";
import { MEMORY_KV_KIND } from "../../sdk/providers/kv/memory.ts";
import { REDIS_KV_KIND, type RedisKvOptions } from "../../sdk/providers/kv/redis.ts";
import { S3_KV_KIND, type S3KvOptions } from "../../sdk/providers/kv/s3.ts";
import type { KvProvider } from "../../sdk/providers.ts";
import { createUnstorageKv } from "../unstorage-kv.ts";
import { resolveApiKey } from "./resolve.ts";

const requireFromHere = createRequire(import.meta.url);

/**
 * Load a CJS unstorage driver factory. The CJS variants use
 * `module.exports = defineDriver(...)` so the require result is the
 * factory itself (not an object with `.default`).
 */
function loadDriver<T>(modulePath: string, label: string): T {
  try {
    return requireFromHere(modulePath) as T;
  } catch (err) {
    if (
      err instanceof Error &&
      ((err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND" ||
        (err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") &&
      err.message.includes(modulePath)
    ) {
      throw new Error(
        `${label} KV: driver \`${modulePath}\` not found. (This should ship with unstorage.)`,
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * Build a lazy unstorage Driver that defers loading the real driver
 * factory until the first I/O operation. This is necessary for drivers
 * whose peer dependencies (e.g. `ioredis`) may not be installed on the
 * host at startup — the missing package will only surface when the agent
 * actually performs KV operations, not at session creation time.
 */
function makeLazyDriver(modulePath: string, label: string, opts: Record<string, unknown>): Driver {
  let resolved: Driver | null = null;
  const get = (): Driver => {
    if (!resolved) {
      const factory = loadDriver<(o: Record<string, unknown>) => Driver>(modulePath, label);
      resolved = factory(opts);
    }
    return resolved;
  };
  return {
    name: label.toLowerCase(),
    hasItem: (key, txOpts) => get().hasItem(key, txOpts),
    getItem: (key, txOpts) => get().getItem(key, txOpts),
    getItemRaw: (key, txOpts) => get().getItemRaw?.(key, txOpts) ?? null,
    setItem: (key, value, txOpts) => get().setItem?.(key, value, txOpts),
    setItemRaw: (key, value, txOpts) => get().setItemRaw?.(key, value, txOpts),
    removeItem: (key, txOpts) => get().removeItem?.(key, txOpts),
    getKeys: (base, txOpts) => get().getKeys(base, txOpts),
    clear: (base, txOpts) => get().clear?.(base, txOpts),
    dispose: () => (resolved ? resolved.dispose?.() : undefined),
  };
}

/** Resolve a {@link KvProvider} descriptor into a {@link Kv}. */
export function resolveKv(descriptor: KvProvider, env: Record<string, string>, prefix: string): Kv {
  switch (descriptor.kind) {
    case MEMORY_KV_KIND: {
      return createUnstorageKv({ storage: createStorage(), prefix });
    }
    case FS_KV_KIND: {
      const opts = descriptor.options as unknown as FsKvOptions;
      const fsDriver = loadDriver<(o: { base: string }) => Driver>("unstorage/drivers/fs", "fs");
      return createUnstorageKv({
        storage: createStorage({ driver: fsDriver({ base: opts.base }) }),
        prefix,
      });
    }
    case S3_KV_KIND: {
      const opts = descriptor.options as unknown as S3KvOptions;
      const accessKeyId = resolveApiKey("AWS_ACCESS_KEY_ID", env);
      const secretAccessKey = resolveApiKey("AWS_SECRET_ACCESS_KEY", env);
      if (!(accessKeyId && secretAccessKey)) {
        throw new Error(
          "S3 KV: missing AWS credentials. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the agent env.",
        );
      }
      const s3Driver = loadDriver<
        (o: {
          bucket: string;
          endpoint?: string;
          region: string;
          accessKeyId: string;
          secretAccessKey: string;
        }) => Driver
      >("unstorage/drivers/s3", "S3");
      return createUnstorageKv({
        storage: createStorage({
          driver: s3Driver({
            bucket: opts.bucket,
            ...(opts.endpoint !== undefined ? { endpoint: opts.endpoint } : {}),
            region: opts.region ?? "auto",
            accessKeyId,
            secretAccessKey,
          }),
        }),
        prefix,
      });
    }
    case REDIS_KV_KIND: {
      const opts = descriptor.options as unknown as RedisKvOptions;
      const url = resolveApiKey("REDIS_URL", env);
      if (!url) {
        throw new Error("Redis KV: missing connection URL. Set REDIS_URL in the agent env.");
      }
      return createUnstorageKv({
        storage: createStorage({
          driver: makeLazyDriver("unstorage/drivers/redis", "Redis", {
            url,
            ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
          }),
        }),
        prefix,
      });
    }
    default:
      throw new Error(
        `Unknown KV provider kind: "${descriptor.kind}". ` +
          `Supported: ${MEMORY_KV_KIND}, ${FS_KV_KIND}, ${S3_KV_KIND}, ${REDIS_KV_KIND}.`,
      );
  }
}
