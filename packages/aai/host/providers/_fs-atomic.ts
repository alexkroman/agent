// Copyright 2025 the AAI authors. MIT license.

/**
 * Atomic-write wrapper for unstorage's fs driver.
 *
 * The stock driver writes values with a plain `fs.writeFile`, so a crash
 * mid-write can leave a truncated file and a concurrent reader can observe a
 * torn value (half-written JSON that fails to parse). Writes here go to a
 * temp file in the same directory and are renamed into place — rename on one
 * filesystem is atomic, so readers only ever see the previous value or the
 * complete new one.
 *
 * Everything except the two write paths delegates to the wrapped driver. The
 * key→path mapping mirrors the driver's own (`unstorage/drivers/fs`): reject
 * `..` segments, then `join(base, key.replace(/:/g, "/"))` — it must stay in
 * lockstep or writes would land where reads never look.
 */

import { promises as fsp } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Driver } from "unstorage";

// Same traversal guard as unstorage/drivers/fs.
const PATH_TRAVERSE_RE = /\.\.:|\.\.$/;

export function withAtomicFsWrites(driver: Driver, base: string): Driver {
  const root = resolve(base);

  function keyPath(key: string): string {
    if (PATH_TRAVERSE_RE.test(key)) {
      throw new Error(`fs KV: invalid key ${JSON.stringify(key)} (contains .. segments)`);
    }
    return join(root, key.replace(/:/g, "/"));
  }

  async function atomicWrite(key: string, value: string | Uint8Array): Promise<void> {
    const target = keyPath(key);
    await fsp.mkdir(dirname(target), { recursive: true });
    const tmpPath = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fsp.writeFile(tmpPath, value);
    try {
      await fsp.rename(tmpPath, target);
    } catch (err) {
      await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  return {
    ...driver,
    setItem: (key, value) => atomicWrite(key, value),
    setItemRaw: (key, value) => atomicWrite(key, value),
  };
}
