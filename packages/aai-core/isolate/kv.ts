// Copyright 2025 the AAI authors. MIT license.
/**
 * Key-value storage interface and shared utilities.
 */

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
   * Close the KV store, releasing any resources (intervals, database handles).
   *
   * After calling `close()`, the store must not be used. This is a no-op
   * for implementations that hold no resources (e.g. in-memory stores).
   */
  close?(): void;
};
