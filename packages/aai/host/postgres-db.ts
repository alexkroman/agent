// Copyright 2026 the AAI authors. MIT license.
/**
 * Postgres-backed implementation of the SDK's {@link Db} capability.
 *
 * Wraps the `postgres` npm package behind the one-method `Db` contract that
 * tool `execute` code sees as `ctx.db`. `prepare: false` keeps the client
 * compatible with transaction-mode connection poolers (Supabase's Supavisor,
 * PgBouncer), which the platform fronts every app schema with.
 */

import postgres from "postgres";
import type { Db } from "../sdk/db.ts";

/** Options for {@link createPostgresDb}. */
export type CreatePostgresDbOptions = {
  /** Postgres connection URL (e.g. the app's `DATABASE_URL`). */
  url: string;
  /** Maximum pooled connections. Defaults to 4. */
  max?: number;
};

/** A {@link Db} whose underlying connection pool the caller owns and must close. */
export type CloseableDb = Db & {
  /** Drain and close the connection pool. The handle must not be used after. */
  close(): Promise<void>;
};

/**
 * Create a {@link Db} backed by a Postgres connection pool.
 *
 * Connections open lazily on first query, so constructing the handle is
 * cheap and never touches the network.
 *
 * @public
 */
export function createPostgresDb(opts: CreatePostgresDbOptions): CloseableDb {
  const sql = postgres(opts.url, { max: opts.max ?? 4, prepare: false });
  return {
    async query<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]> {
      // The driver types parameters as its serializable union; `ctx.db` keeps
      // the caller-facing contract at `unknown[]` and lets the driver reject
      // non-serializable values at runtime.
      const rows = await sql.unsafe(query, (params ?? []) as postgres.ParameterOrJSON<never>[]);
      return [...rows] as T[];
    },
    async close(): Promise<void> {
      await sql.end();
    },
  };
}
