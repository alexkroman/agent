// Copyright 2025 the AAI authors. MIT license.
/**
 * SQLite-backed key-value storage for local development.
 *
 * Persists data across restarts using a local SQLite database file.
 * Drop-in replacement for the in-memory KV store.
 */

import Database from "better-sqlite3";
import type { Kv, KvEntry, KvListOptions } from "./kv.ts";
import { MAX_VALUE_SIZE, matchGlob, sortAndPaginate } from "./kv.ts";

/**
 * Options for creating a SQLite-backed KV store.
 */
export type SqliteKvOptions = {
  /** Path to the SQLite database file. Defaults to `.aai/local.db`. */
  path?: string;
};

/**
 * Create a SQLite-backed KV store for local development.
 *
 * Data persists to a local SQLite file (default: `.aai/local.db`).
 * TTL expiration is enforced on reads and periodically cleaned up.
 *
 * @param options - Optional configuration. See {@link SqliteKvOptions}.
 * @returns A {@link Kv} instance backed by SQLite.
 *
 * @example
 * ```ts
 * import { createSqliteKv } from "@alexkroman1/aai/sqlite-kv";
 *
 * const kv = createSqliteKv();
 * await kv.set("greeting", "hello");
 * const value = await kv.get<string>("greeting"); // "hello"
 * ```
 */
export function createSqliteKv(options?: SqliteKvOptions): Kv {
  const dbPath = options?.path ?? ".aai/local.db";
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER
    )
  `);

  // Create index for prefix/expiry queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_kv_expires_at ON kv(expires_at)
      WHERE expires_at IS NOT NULL
  `);

  const stmtGet = db.prepare<[string], { value: string; expires_at: number | null }>(
    "SELECT value, expires_at FROM kv WHERE key = ?",
  );
  const stmtUpsert = db.prepare<[string, string, number | null]>(
    "INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
  );
  const stmtDelete = db.prepare<[string]>("DELETE FROM kv WHERE key = ?");
  const stmtDeleteExpired = db.prepare<[number]>(
    "DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?",
  );
  const stmtListPrefix = db.prepare<[string, string, number], { key: string; value: string }>(
    "SELECT key, value FROM kv WHERE key >= ? AND key < ? AND (expires_at IS NULL OR expires_at > ?)",
  );
  const stmtListAll = db.prepare<[number], { key: string; value: string }>(
    "SELECT key, value FROM kv WHERE expires_at IS NULL OR expires_at > ?",
  );
  const stmtKeysAll = db.prepare<[number], { key: string }>(
    "SELECT key FROM kv WHERE expires_at IS NULL OR expires_at > ?",
  );
  const stmtKeysPrefix = db.prepare<[string, string, number], { key: string }>(
    "SELECT key FROM kv WHERE key >= ? AND key < ? AND (expires_at IS NULL OR expires_at > ?)",
  );

  /** Compute the exclusive upper bound for a prefix scan. */
  function prefixUpperBound(prefix: string): string {
    if (prefix === "") return "\uffff";
    const last = prefix.charCodeAt(prefix.length - 1);
    return prefix.slice(0, -1) + String.fromCharCode(last + 1);
  }

  // Periodically clean up expired entries (every 60s)
  const cleanupInterval = setInterval(() => {
    stmtDeleteExpired.run(Date.now());
  }, 60_000);
  // Don't block process exit
  if (cleanupInterval.unref) cleanupInterval.unref();

  return {
    get<T = unknown>(key: string): Promise<T | null> {
      const now = Date.now();
      const row = stmtGet.get(key);
      if (!row) return Promise.resolve(null);
      if (row.expires_at !== null && row.expires_at <= now) {
        stmtDelete.run(key);
        return Promise.resolve(null);
      }
      return Promise.resolve(JSON.parse(row.value) as T);
    },

    set(key: string, value: unknown, options?: { expireIn?: number }): Promise<void> {
      try {
        const raw = JSON.stringify(value);
        if (raw.length > MAX_VALUE_SIZE) {
          return Promise.reject(new Error(`Value exceeds max size of ${MAX_VALUE_SIZE} bytes`));
        }
        const expireIn = options?.expireIn;
        const expiresAt = expireIn && expireIn > 0 ? Date.now() + expireIn : null;
        stmtUpsert.run(key, raw, expiresAt);
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(err);
      }
    },

    delete(keys: string | string[]): Promise<void> {
      const keyArray = Array.isArray(keys) ? keys : [keys];
      const deleteMany = db.transaction((ks: string[]) => {
        for (const k of ks) stmtDelete.run(k);
      });
      deleteMany(keyArray);
      return Promise.resolve();
    },

    list<T = unknown>(prefix: string, options?: KvListOptions): Promise<KvEntry<T>[]> {
      const now = Date.now();
      let rows: { key: string; value: string }[];
      if (prefix === "") {
        rows = stmtListAll.all(now);
      } else {
        const upper = prefixUpperBound(prefix);
        rows = stmtListPrefix.all(prefix, upper, now);
      }
      const entries: KvEntry<T>[] = rows.map((row) => ({
        key: row.key,
        value: JSON.parse(row.value) as T,
      }));
      return Promise.resolve(sortAndPaginate(entries, options));
    },

    keys(pattern?: string): Promise<string[]> {
      const now = Date.now();
      const isGlob = pattern?.includes("*");

      if (!pattern) {
        const rows = stmtKeysAll.all(now);
        const keys = rows.map((r) => r.key);
        return Promise.resolve(keys.sort((a, b) => a.localeCompare(b)));
      }

      if (isGlob) {
        // Extract prefix before the first `*` for an efficient scan
        const starIdx = pattern.indexOf("*");
        const prefix = pattern.slice(0, starIdx);
        let rows: { key: string }[];
        if (prefix === "") {
          rows = stmtKeysAll.all(now);
        } else {
          const upper = prefixUpperBound(prefix);
          rows = stmtKeysPrefix.all(prefix, upper, now);
        }
        const keys = rows.filter((r) => matchGlob(r.key, pattern)).map((r) => r.key);
        return Promise.resolve(keys.sort((a, b) => a.localeCompare(b)));
      }

      // Plain prefix match
      const upper = prefixUpperBound(pattern);
      const rows = stmtKeysPrefix.all(pattern, upper, now);
      const keys = rows.map((r) => r.key);
      return Promise.resolve(keys.sort((a, b) => a.localeCompare(b)));
    },
  };
}
