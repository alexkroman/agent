// Copyright 2025 the AAI authors. MIT license.
/**
 * Key-value storage interface and in-memory implementation.
 */

/**
 * A single key-value entry returned by {@link Kv.list}.
 *
 * @typeParam T - The type of the stored value. Defaults to `unknown`.
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
 * Used with {@link Kv.list} to control result ordering and pagination.
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
 * Agents access the KV store via {@link ToolContext.kv} or
 * {@link HookContext.kv}. Values are JSON-serialized and stored as
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
   * @param options - Optional settings. `expireIn` sets the time-to-live in milliseconds. The entry is
   *   automatically removed after this duration.
   * @throws {Error} If the serialized value exceeds 65,536 bytes.
   */
  set(key: string, value: unknown, options?: { expireIn?: number }): Promise<void>;
  /**
   * Delete a key.
   *
   * @param key - The key to remove. No-op if the key does not exist.
   */
  delete(key: string): Promise<void>;
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
   * List all keys, optionally filtered by a glob-style pattern.
   *
   * @param pattern - Optional glob pattern (e.g. `"user:*"`). If omitted, all keys are returned.
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
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (options?.reverse) entries.reverse();
  if (options?.limit && options.limit > 0) {
    entries.length = Math.min(entries.length, options.limit);
  }
  return entries;
}

/** Simple glob matcher — supports `*` as a wildcard for any characters. */
function matchGlob(key: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(key);
}

/**
 * Create an in-memory KV store (useful for testing and local development).
 *
 * Data is stored in a plain `Map` and does not persist across restarts.
 * TTL expiration is checked lazily on reads and list operations.
 *
 * @returns A {@link Kv} instance backed by in-memory storage.
 *
 * @example
 * ```ts
 * import { createMemoryKv } from "./kv.ts";
 *
 * const kv = createMemoryKv();
 * await kv.set("greeting", "hello");
 * const value = await kv.get<string>("greeting"); // "hello"
 * ```
 *
 * @example With TTL
 * ```ts
 * import { createMemoryKv } from "./kv.ts";
 *
 * const kv = createMemoryKv();
 * await kv.set("temp", "expires soon", { expireIn: 5000 });
 * ```
 */
export function createMemoryKv(): Kv {
  const store = new Map<string, { raw: string; expiresAt?: number }>();

  function isExpired(entry: { expiresAt?: number }): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt <= Date.now();
  }

  return {
    get<T = unknown>(key: string): Promise<T | null> {
      const entry = store.get(key);
      if (!entry || isExpired(entry)) {
        if (entry) store.delete(key);
        return Promise.resolve(null);
      }
      return Promise.resolve(JSON.parse(entry.raw) as T);
    },

    set(key: string, value: unknown, options?: { expireIn?: number }): Promise<void> {
      const raw = JSON.stringify(value);
      if (raw.length > MAX_VALUE_SIZE) {
        throw new Error(`Value exceeds max size of ${MAX_VALUE_SIZE} bytes`);
      }
      const expireIn = options?.expireIn;
      const entry: { raw: string; expiresAt?: number } = { raw };
      if (expireIn && expireIn > 0) {
        entry.expiresAt = Date.now() + expireIn;
      }
      store.set(key, entry);
      return Promise.resolve();
    },

    delete(key: string): Promise<void> {
      store.delete(key);
      return Promise.resolve();
    },

    async list<T = unknown>(prefix: string, options?: KvListOptions): Promise<KvEntry<T>[]> {
      const now = Date.now();
      const entries: KvEntry<T>[] = [];
      let i = 0;
      for (const [key, entry] of store) {
        if (++i % 500 === 0) await new Promise<void>((r) => setTimeout(r, 0));
        if (entry.expiresAt && entry.expiresAt <= now) {
          store.delete(key);
          continue;
        }
        if (key.startsWith(prefix)) {
          entries.push({ key, value: JSON.parse(entry.raw) as T });
        }
      }
      return sortAndPaginate(entries, options);
    },

    async keys(pattern?: string): Promise<string[]> {
      const now = Date.now();
      const result: string[] = [];
      for (const [key, entry] of store) {
        if (entry.expiresAt && entry.expiresAt <= now) {
          store.delete(key);
          continue;
        }
        if (!pattern || matchGlob(key, pattern)) {
          result.push(key);
        }
      }
      return result.sort();
    },
  };
}
