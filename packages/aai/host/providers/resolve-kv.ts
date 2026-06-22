// Copyright 2025 the AAI authors. MIT license.

import { createStorage, type Driver } from "unstorage";
import type { Kv } from "../../sdk/kv.ts";
import { FS_KV_KIND, type FsKvOptions } from "../../sdk/providers/kv/fs.ts";
import { MEMORY_KV_KIND } from "../../sdk/providers/kv/memory.ts";
import { REDIS_KV_KIND, type RedisKvOptions } from "../../sdk/providers/kv/redis.ts";
import { S3_KV_KIND, type S3KvOptions } from "../../sdk/providers/kv/s3.ts";
import type { KvProvider } from "../../sdk/providers.ts";
import { createUnstorageKv } from "../unstorage-kv.ts";
import { loadProviderPackage, options, resolveApiKey } from "./resolve.ts";

type DriverFactory<O> = (opts: O) => Driver;

// Defers driver factory loading until first I/O so missing optional peer
// deps (e.g. `ioredis`) surface at use-time rather than session start.
function makeLazyDriver(modulePath: string, label: string, opts: Record<string, unknown>): Driver {
  let resolved: Driver | null = null;
  function get(): Driver {
    if (!resolved) {
      resolved = loadProviderPackage<DriverFactory<Record<string, unknown>>>(
        modulePath,
        `${label} KV: driver`,
      )(opts);
    }
    return resolved;
  }
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
    dispose: () => resolved?.dispose?.(),
  };
}

function makeKv(driver: Driver, prefix: string): Kv {
  return createUnstorageKv({ storage: createStorage({ driver }), prefix });
}

export function resolveKv(descriptor: KvProvider, env: Record<string, string>, prefix: string): Kv {
  switch (descriptor.kind) {
    case MEMORY_KV_KIND:
      return createUnstorageKv({ storage: createStorage(), prefix });

    case FS_KV_KIND: {
      const opts = options<FsKvOptions>(descriptor);
      const fsDriver = loadProviderPackage<DriverFactory<{ base: string }>>(
        "unstorage/drivers/fs",
        "fs KV: driver",
      );
      return makeKv(fsDriver({ base: opts.base }), prefix);
    }

    case S3_KV_KIND: {
      const opts = options<S3KvOptions>(descriptor);
      const accessKeyId = resolveApiKey("AWS_ACCESS_KEY_ID", env);
      const secretAccessKey = resolveApiKey("AWS_SECRET_ACCESS_KEY", env);
      if (!(accessKeyId && secretAccessKey)) {
        throw new Error(
          "S3 KV: missing AWS credentials. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the agent env.",
        );
      }
      const s3Driver = loadProviderPackage<
        DriverFactory<{
          bucket: string;
          endpoint?: string;
          region: string;
          accessKeyId: string;
          secretAccessKey: string;
        }>
      >("unstorage/drivers/s3", "S3 KV: driver");
      return makeKv(
        s3Driver({
          bucket: opts.bucket,
          ...(opts.endpoint !== undefined && { endpoint: opts.endpoint }),
          region: opts.region ?? "auto",
          accessKeyId,
          secretAccessKey,
        }),
        prefix,
      );
    }

    case REDIS_KV_KIND: {
      const opts = options<RedisKvOptions>(descriptor);
      const url = resolveApiKey("REDIS_URL", env);
      if (!url) {
        throw new Error("Redis KV: missing connection URL. Set REDIS_URL in the agent env.");
      }
      return makeKv(
        makeLazyDriver("unstorage/drivers/redis", "Redis", { url, tls: opts.tls }),
        prefix,
      );
    }

    default:
      throw new Error(
        `Unknown KV provider kind: "${descriptor.kind}". ` +
          `Supported: ${MEMORY_KV_KIND}, ${FS_KV_KIND}, ${S3_KV_KIND}, ${REDIS_KV_KIND}.`,
      );
  }
}
