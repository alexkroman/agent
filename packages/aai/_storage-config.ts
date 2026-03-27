// Copyright 2025 the AAI authors. MIT license.
/**
 * Load an unstorage driver from `.aai/storage.json` config file.
 *
 * If the config file doesn't exist, returns an in-memory storage instance.
 * The config `driver` field selects the unstorage driver; remaining fields
 * are passed as driver options.
 *
 * Supported drivers:
 * - `"memory"` (default) — in-memory, no persistence
 * - `"fs"` — filesystem persistence (requires `base` path)
 * - `"s3"` — S3-compatible storage (requires `bucket`, `endpoint`, credentials)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createStorage, type Storage } from "unstorage";

type StorageConfig =
  | { driver: "memory" }
  | { driver: "fs"; base: string }
  | {
      driver: "s3";
      bucket: string;
      endpoint: string;
      region?: string;
      accessKeyId: string;
      secretAccessKey: string;
    };

/**
 * Load an unstorage `Storage` instance from `.aai/storage.json`.
 *
 * Falls back to in-memory storage if the config file doesn't exist.
 *
 * @param configDir - Directory containing `storage.json`. Defaults to `.aai`.
 */
export async function loadStorageFromConfig(configDir = ".aai"): Promise<Storage> {
  const configPath = join(configDir, "storage.json");

  if (!existsSync(configPath)) {
    return createStorage();
  }

  const raw = JSON.parse(readFileSync(configPath, "utf-8")) as StorageConfig;

  switch (raw.driver) {
    case "memory":
      return createStorage();

    case "fs": {
      const { default: fsDriver } = await import("unstorage/drivers/fs");
      return createStorage({ driver: fsDriver({ base: raw.base }) });
    }

    case "s3": {
      const { default: s3Driver } = await import("unstorage/drivers/s3");
      return createStorage({
        driver: s3Driver({
          bucket: raw.bucket,
          endpoint: raw.endpoint,
          region: raw.region ?? "auto",
          accessKeyId: raw.accessKeyId,
          secretAccessKey: raw.secretAccessKey,
        }),
      });
    }

    default:
      throw new Error(`Unknown storage driver: ${(raw as { driver: string }).driver}`);
  }
}
