// Copyright 2026 the AAI authors. MIT license.
/**
 * Process-wide cache of studio build outputs, keyed by workspace `filesHash`.
 *
 * The common studio flow builds the same content twice: `test_agent` bundles
 * the workspace to trial it in the sandbox, then Publish re-materializes and
 * rebuilds the exact same files. Content-hash keying makes the cache
 * trivially correct — a hash names one immutable input, so entries never need
 * invalidating; they only age out of the LRU.
 *
 * An entry can hold the worker bundle, the built client files, or both:
 * `test_agent` only builds the worker, so a Publish after it hits the worker
 * half and only pays the client build. Bounded two ways — entry count (a
 * handful of hot workspaces is the realistic working set) and total bytes
 * (workers can approach MAX_WORKER_SIZE).
 */

/** Cached outputs for one workspace content hash. Halves fill independently. */
export type StudioBuildEntry = {
  worker?: string;
  clientFiles?: Record<string, string>;
};

const MAX_ENTRIES = 8;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

type Stored = { entry: StudioBuildEntry; bytes: number };

/** Insertion order doubles as LRU order — reads re-insert. */
const cache = new Map<string, Stored>();
let totalBytes = 0;

function entryBytes(entry: StudioBuildEntry): number {
  let bytes = entry.worker?.length ?? 0;
  for (const [name, content] of Object.entries(entry.clientFiles ?? {})) {
    bytes += name.length + content.length;
  }
  return bytes;
}

export function getCachedBuild(hash: string): StudioBuildEntry | null {
  const stored = cache.get(hash);
  if (!stored) return null;
  // Refresh recency.
  cache.delete(hash);
  cache.set(hash, stored);
  return stored.entry;
}

/**
 * Merge `patch` into the entry for `hash` (a worker-only store followed by a
 * client store leaves both cached) and evict least-recently-used entries past
 * the count/byte budgets. A patch too large to ever fit is simply not cached.
 */
export function putCachedBuild(hash: string, patch: StudioBuildEntry): void {
  const existing = cache.get(hash);
  const entry: StudioBuildEntry = { ...existing?.entry, ...patch };
  const bytes = entryBytes(entry);
  if (bytes > MAX_TOTAL_BYTES) return;
  if (existing) {
    cache.delete(hash);
    totalBytes -= existing.bytes;
  }
  cache.set(hash, { entry, bytes });
  totalBytes += bytes;
  for (const [oldest, stored] of cache) {
    if (cache.size <= MAX_ENTRIES && totalBytes <= MAX_TOTAL_BYTES) break;
    if (oldest === hash) continue; // never evict what was just stored
    cache.delete(oldest);
    totalBytes -= stored.bytes;
  }
}

/** Test seam: reset the cache between tests sharing file contents. */
export function clearStudioBuildCache(): void {
  cache.clear();
  totalBytes = 0;
}
