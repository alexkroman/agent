// Copyright 2025 the AAI authors. MIT license.

import { createStorage, type Driver } from "unstorage";
import type { Kv } from "../../sdk/kv.ts";
import { FS_KV_KIND, type FsKvOptions } from "../../sdk/providers/kv/fs.ts";
import { MEMORY_KV_KIND } from "../../sdk/providers/kv/memory.ts";
import {
  REDIS_KV_KIND,
  REDIS_KV_URL_ENV,
  type RedisKvOptions,
} from "../../sdk/providers/kv/redis.ts";
import {
  S3_KV_ACCESS_KEY_ID_ENV,
  S3_KV_KIND,
  S3_KV_SECRET_ACCESS_KEY_ENV,
  type S3KvOptions,
} from "../../sdk/providers/kv/s3.ts";
import type { KvProvider } from "../../sdk/providers.ts";
import { createUnstorageKv } from "../unstorage-kv.ts";
import { loadProviderPackage, resolveApiKey } from "./resolve.ts";

type DriverFactory<O> = (opts: O) => Driver;

function loadDriver<O>(modulePath: string, label: string): DriverFactory<O> {
  return loadProviderPackage<DriverFactory<O>>(modulePath, `${label} KV: driver`);
}

// Defers driver factory loading until first I/O so missing optional peer
// deps (e.g. `ioredis`) surface at use-time rather than session start.
function makeLazyDriver(modulePath: string, label: string, opts: Record<string, unknown>): Driver {
  let resolved: Driver | null = null;
  function get(): Driver {
    if (!resolved) {
      resolved = loadDriver<Record<string, unknown>>(modulePath, label)(opts);
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

export function resolveKv(descriptor: KvProvider, env: Record<string, string>, prefix: string): Kv {
  switch (descriptor.kind) {
    case MEMORY_KV_KIND:
      return createUnstorageKv({ storage: createStorage(), prefix });

    case FS_KV_KIND: {
      const opts = descriptor.options as unknown as FsKvOptions;
      const fsDriver = loadDriver<{ base: string }>("unstorage/drivers/fs", "fs");
      return createUnstorageKv({
        storage: createStorage({ driver: fsDriver({ base: opts.base }) }),
        prefix,
      });
    }

    case S3_KV_KIND: {
      const opts = descriptor.options as unknown as S3KvOptions;
      const accessKeyId = resolveApiKey(S3_KV_ACCESS_KEY_ID_ENV, env);
      const secretAccessKey = resolveApiKey(S3_KV_SECRET_ACCESS_KEY_ENV, env);
      if (!(accessKeyId && secretAccessKey)) {
        throw new Error(
          `S3 KV: missing AWS credentials. Set ${S3_KV_ACCESS_KEY_ID_ENV} and ${S3_KV_SECRET_ACCESS_KEY_ENV} in the agent env.`,
        );
      }
      const s3Driver = loadDriver<{
        bucket: string;
        endpoint?: string;
        region: string;
        accessKeyId: string;
        secretAccessKey: string;
      }>("unstorage/drivers/s3", "S3");
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
      const url = resolveApiKey(REDIS_KV_URL_ENV, env);
      if (!url) {
        throw new Error(
          `Redis KV: missing connection URL. Set ${REDIS_KV_URL_ENV} in the agent env.`,
        );
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
