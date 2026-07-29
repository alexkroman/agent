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
 * key→path mapping mirrors the driver's own (`unstorage/drivers/fs`):
 * `key.replace(/:/g, "/")` under `base`. KV keys are attacker-controlled (a
 * guest RPC or agent tool can set any string), so the mapped path is confirmed
 * to stay inside the root before any filesystem op — see {@link assertSafeKey}.
 */

import { promises as fsp } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { Driver } from "unstorage";

// Upper bound on key length. Long keys map to long paths that blow past the
// filesystem's NAME_MAX/PATH_MAX; bounding it also caps the traversal check.
const MAX_KEY_LENGTH = 1024;

export function withAtomicFsWrites(driver: Driver, base: string): Driver {
  const root = resolve(base);

  /**
   * Map a KV key to an absolute path and confirm it stays within `root`.
   *
   * The stock driver's guard (`/\.\.:|\.\.$/`) only catches `..:` or a trailing
   * `..` — it misses `../` with a literal slash, so a key like
   * `../../../etc/cron.d/x` escaped the KV directory into a host-filesystem
   * write primitive. Resolving the joined path and checking it is `root` or
   * sits under `root + sep` rejects every escape regardless of form.
   */
  function keyPath(key: string): string {
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
      throw new Error(`fs KV: invalid key length ${key.length} (max ${MAX_KEY_LENGTH})`);
    }
    const target = resolve(root, key.replace(/:/g, "/"));
    // Must sit strictly under the root: `startsWith(root + sep)` rejects both
    // an escape (`../…`) and a key that maps to the root directory itself
    // (`foo:..`), which is not a valid item path.
    if (!target.startsWith(root + sep)) {
      throw new Error(`fs KV: invalid key ${JSON.stringify(key)} (escapes the KV root)`);
    }
    return target;
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

  // Validate the key on every path-taking op, not just writes: reads and
  // deletes with an escaping key are an info-leak / out-of-root-unlink
  // primitive too. The stock driver would apply only its weak guard. Only
  // methods the wrapped driver actually defines are overridden.
  const reads: Partial<Driver> = {};
  const get = driver.getItem?.bind(driver);
  if (get)
    reads.getItem = (key, opts) => {
      keyPath(key);
      return get(key, opts);
    };
  const getRaw = driver.getItemRaw?.bind(driver);
  if (getRaw)
    reads.getItemRaw = (key, opts) => {
      keyPath(key);
      return getRaw(key, opts);
    };
  const has = driver.hasItem?.bind(driver);
  if (has)
    reads.hasItem = (key, opts) => {
      keyPath(key);
      return has(key, opts);
    };
  const remove = driver.removeItem?.bind(driver);
  if (remove)
    reads.removeItem = (key, opts) => {
      keyPath(key);
      return remove(key, opts);
    };

  return {
    ...driver,
    ...reads,
    setItem: (key, value) => atomicWrite(key, value),
    setItemRaw: (key, value) => atomicWrite(key, value),
  };
}
