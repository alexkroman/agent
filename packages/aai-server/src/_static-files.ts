// Copyright 2026 the AAI authors. MIT license.
/**
 * Disk-backed static file reading shared by transport-websocket.ts (the
 * aai-ui default client) and studio/studio-static.ts (the studio client
 * build). Both serve a `require.resolve`d dist directory through hono
 * handlers that layer their own logic on top (store-first fallback, CSP,
 * fallback page), so `@hono/node-server/serve-static` does not fit — this
 * helper is the common core underneath.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "@alexkroman1/aai-runtime/internal";

// Consumed by transport-websocket.ts and studio/* alongside the reader below.
export { isPathInside } from "@alexkroman1/aai-runtime/internal";

/**
 * Content-cached reader over one directory.
 *
 * - `getBaseDir` is called lazily, so `require.resolve` costs land on first
 *   use rather than at import time.
 * - Misses are NOT cached: during parallel build+test runs (turbo) the file
 *   may be written after the first read, and caching null would permanently
 *   shadow it.
 * - Paths resolving outside the directory return null, never a file.
 */
export function createCachedDirReader(
  getBaseDir: () => string,
): (relPath: string) => Promise<Buffer | null> {
  const cache = new Map<string, Buffer>();
  return async (relPath: string): Promise<Buffer | null> => {
    const cached = cache.get(relPath);
    if (cached !== undefined) return cached;
    const baseDir = getBaseDir();
    const fullPath = path.join(baseDir, relPath);
    if (!isPathInside(baseDir, fullPath)) return null;
    try {
      const content = await readFile(fullPath);
      cache.set(relPath, content);
      return content;
    } catch {
      return null;
    }
  };
}
