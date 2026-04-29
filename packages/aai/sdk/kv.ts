// Copyright 2025 the AAI authors. MIT license.

/**
 * Async key-value store interface used by agents.
 *
 * Agents access the KV store via `ToolContext.kv`. Values are JSON-serialized
 * and stored as strings with an optional TTL.
 *
 * @example
 * ```ts
 * await ctx.kv.set("user:name", "Alice", { expireIn: 60_000 });
 * const name = await ctx.kv.get<string>("user:name"); // "Alice"
 * ```
 *
 * @public
 */
export type Kv = {
  /** Get a value by key. Returns `null` if missing or expired. */
  get<T = unknown>(key: string): Promise<T | null>;
  /**
   * Set a value, optionally with a TTL.
   *
   * @param options.expireIn - Time-to-live in **milliseconds** (e.g. `60_000`
   *   for 1 minute). The entry is automatically removed after this duration.
   * @throws If the serialized value exceeds 65,536 bytes.
   */
  set(key: string, value: unknown, options?: { expireIn?: number }): Promise<void>;
  /** Delete one or more keys. No-op for keys that do not exist. */
  delete(keys: string | string[]): Promise<void>;
  /**
   * Release any held resources (intervals, database handles). After calling,
   * the store must not be used. No-op for stateless implementations (e.g.
   * in-memory stores).
   */
  close?(): void;
};
