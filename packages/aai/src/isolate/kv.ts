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
  /**
   * Close the KV store, releasing any resources (intervals, database handles).
   *
   * After calling `close()`, the store must not be used. This is a no-op
   * for implementations that hold no resources (e.g. in-memory stores).
   */
  close?(): void;
};
