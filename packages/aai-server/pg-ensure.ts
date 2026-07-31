// Copyright 2026 the AAI authors. MIT license.
/**
 * One implementation of the platform stores' lazy DDL bootstrap: memoized
 * "create schema + create table (+ indexes)" that resets on failure so a
 * transient DDL error doesn't wedge the store for the process lifetime.
 * Every `aai_platform` store (locks, epochs, session state, workspaces,
 * chats, studio rate limits) uses this instead of hand-rolling the memo.
 */

import type { SqlExec } from "./secret-store.ts";

const ENSURE_SCHEMA_SQL = "create schema if not exists aai_platform";

/** Returns an idempotent, memoized ensure() over the given DDL statements. */
export function ensureTableOnce(sql: SqlExec, ...ddl: string[]): () => Promise<void> {
  let ensured: Promise<void> | null = null;
  return () => {
    ensured ??= (async () => {
      await sql(ENSURE_SCHEMA_SQL);
      for (const statement of ddl) await sql(statement);
    })().catch((err: unknown) => {
      ensured = null;
      throw err;
    });
    return ensured;
  };
}
