// Copyright 2025 the AAI authors. MIT license.
/**
 * SQLite-backed vector store for local development.
 *
 * Persists data across restarts using a local SQLite database file.
 * Uses brute-force word matching (same as the in-memory implementation)
 * since real embeddings require a remote service.
 */

import Database from "better-sqlite3";
import type { VectorEntry, VectorStore } from "./vector.ts";

/**
 * Options for creating a SQLite-backed vector store.
 */
export type SqliteVectorStoreOptions = {
  /** Path to the SQLite database file. Defaults to `.aai/local.db`. */
  path?: string;
};

/**
 * Create a SQLite-backed vector store for local development.
 *
 * Data persists to a local SQLite file (default: `.aai/local.db`).
 * Uses brute-force word matching for queries (same scoring as the
 * in-memory implementation).
 *
 * @param options - Optional configuration. See {@link SqliteVectorStoreOptions}.
 * @returns A {@link VectorStore} instance backed by SQLite.
 *
 * @example
 * ```ts
 * import { createSqliteVectorStore } from "@alexkroman1/aai/sqlite-vector";
 *
 * const vector = createSqliteVectorStore();
 * await vector.upsert("doc-1", "The capital of France is Paris.");
 * const results = await vector.query("France capital");
 * ```
 */
export function createSqliteVectorStore(options?: SqliteVectorStoreOptions): VectorStore {
  const dbPath = options?.path ?? ".aai/local.db";
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS vector_store (
      id       TEXT PRIMARY KEY,
      data     TEXT NOT NULL,
      metadata TEXT
    )
  `);

  const stmtUpsert = db.prepare<[string, string, string | null]>(
    "INSERT INTO vector_store (id, data, metadata) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, metadata = excluded.metadata",
  );
  const stmtDelete = db.prepare<[string]>("DELETE FROM vector_store WHERE id = ?");
  const stmtAll = db.prepare<[], { id: string; data: string; metadata: string | null }>(
    "SELECT id, data, metadata FROM vector_store",
  );

  return {
    upsert(id: string, data: string, metadata?: Record<string, unknown>): Promise<void> {
      const metaJson = metadata ? JSON.stringify(metadata) : null;
      stmtUpsert.run(id, data, metaJson);
      return Promise.resolve();
    },

    query(text: string, options?: { topK?: number; filter?: string }): Promise<VectorEntry[]> {
      const topK = options?.topK ?? 10;
      const query = text.toLowerCase();
      const words = query.split(/\s+/).filter(Boolean);
      const results: VectorEntry[] = [];

      const rows = stmtAll.all();
      for (const row of rows) {
        const data = row.data.toLowerCase();
        const matches = words.filter((w) => data.includes(w)).length;
        if (matches > 0) {
          results.push({
            id: row.id,
            score: matches / Math.max(words.length, 1),
            data: row.data,
            metadata: row.metadata
              ? (JSON.parse(row.metadata) as Record<string, unknown>)
              : undefined,
          });
        }
      }

      results.sort((a, b) => b.score - a.score);
      return Promise.resolve(results.slice(0, topK));
    },

    delete(ids: string | string[]): Promise<void> {
      const idArray = Array.isArray(ids) ? ids : [ids];
      const deleteMany = db.transaction((idsToDelete: string[]) => {
        for (const id of idsToDelete) stmtDelete.run(id);
      });
      deleteMany(idArray);
      return Promise.resolve();
    },
  };
}
