// Copyright 2025 the AAI authors. MIT license.
/**
 * Key-value storage interface and shared utilities.
 */

/**
 * A single key-value entry returned by {@link Kv.list}.
 *
 * @typeParam T - The type of the stored value. Defaults to `unknown`.
 *
 * @public
 */
export type KvEntry<T = unknown> = {
  /** The key under which the value is stored. */
  key: string;
  /** The deserialized value. */
  value: T;
};

/**
 * Options for listing keys from the KV store.
 *
 * Used with {@link Kv.list} and {@link Kv.keys} to control filtering,
 * ordering, and pagination.
 *
 * @public
 */
export type KvListOptions = {
  /** Maximum number of entries to return. */
  limit?: number;
  /** Return entries in reverse key order. */
  reverse?: boolean;
};

/**
 * Async key-value store interface used by agents.
 *
 * Agents access the KV store via `ToolContext.kv` or
 * `HookContext.kv`. Values are JSON-serialized and stored as
 * strings with an optional TTL.
 *
 * @example
 * ```ts
 * // Inside a tool execute function:
 * const myTool = {
 *   description: "Save and retrieve data",
 *   execute: async (_args: unknown, ctx: { kv: Kv }) => {
 *     await ctx.kv.set("user:name", "Alice", { expireIn: 60_000 });
 *     const name = await ctx.kv.get<string>("user:name");
 *     return name; // "Alice"
 *   },
 * };
 * ```
 *
 * @public
 */
export type Kv = {
  /**
   * Get a value by key, or `null` if not found.
   *
   * @typeParam T - The expected type of the stored value.
   * @param key - The key to look up.
   * @returns The deserialized value, or `null` if the key does not exist
   *   or has expired.
   */
  get<T = unknown>(key: string): Promise<T | null>;
  /**
   * Set a value, optionally with a TTL in milliseconds.
   *
   * @param key - The key to store the value under.
   * @param value - The value to store. Must be JSON-serializable.
   * @param options - Optional settings. `expireIn` sets the time-to-live in **milliseconds**
   *   (e.g. `60_000` for 1 minute). The entry is automatically removed after this duration.
   * @throws Throws an Error if the serialized value exceeds 65,536 bytes.
   */
  set(key: string, value: unknown, options?: { expireIn?: number }): Promise<void>;
  /**
   * Delete one or more keys.
   *
   * @param keys - A single key or array of keys to delete. No-op for keys that do not exist.
   */
  delete(keys: string | string[]): Promise<void>;
  /**
   * List entries whose keys start with the given prefix.
   *
   * Results are sorted by key in ascending lexicographic order by default.
   *
   * @typeParam T - The expected type of the stored values.
   * @param prefix - Key prefix to filter by. Use `""` to list all entries.
   * @param options - Optional pagination and ordering settings.
   * @returns An array of matching {@link KvEntry} objects.
   */
  list<T = unknown>(prefix: string, options?: KvListOptions): Promise<KvEntry<T>[]>;
  /**
   * List all keys, optionally filtered by a prefix or glob-style pattern.
   *
   * @param pattern - Optional prefix string or glob pattern (e.g. `"user:*"`).
   *   A pattern without wildcards (`*`) is treated as a prefix match.
   *   If omitted, all keys are returned.
   * @returns An array of matching key strings.
   */
  keys(pattern?: string): Promise<string[]>;
};

export const MAX_VALUE_SIZE = 65_536;

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

/** Maximum allowed glob pattern length to prevent ReDoS. */
const MAX_GLOB_PATTERN_LENGTH = 1024;

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
