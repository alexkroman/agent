// Copyright 2025 the AAI authors. MIT license.
/** Internal KV helpers shared by kv.ts and unstorage-kv.ts. */

import { MAX_GLOB_PATTERN_LENGTH } from "./constants.ts";

/** Sort entries by key and apply reverse/limit options. Mutates the array. */
export function sortAndPaginate<T extends { key: string }>(
  entries: T[],
  options?: { limit?: number; reverse?: boolean },
): T[] {
  entries.sort((a, b) => a.key.localeCompare(b.key));
  if (options?.reverse) entries.reverse();
  if (options?.limit && options.limit > 0) {
    entries.length = Math.min(entries.length, options.limit);
  }
  return entries;
}

/** Simple glob matcher — supports `*` as a wildcard for any characters. */
export function matchGlob(key: string, pattern: string): boolean {
  if (pattern.length > MAX_GLOB_PATTERN_LENGTH) {
    throw new Error(`Glob pattern exceeds maximum length of ${MAX_GLOB_PATTERN_LENGTH}`);
  }
  // Split on `*`, match each literal segment in order.
  const parts = pattern.split("*");
  if (parts.length === 1) return key === pattern;

  // First segment must be a prefix
  const first = parts[0] as string;
  if (!key.startsWith(first)) return false;

  // Last segment must be a suffix
  const last = parts.at(-1) as string;
  if (key.length < first.length + last.length) return false;
  if (!key.endsWith(last)) return false;

  // Middle segments must appear in order between prefix and suffix
  let pos = first.length;
  const end = key.length - last.length;
  for (const part of parts.slice(1, -1)) {
    const idx = key.indexOf(part, pos);
    if (idx === -1 || idx > end) return false;
    pos = idx + part.length;
  }
  return pos <= end;
}
