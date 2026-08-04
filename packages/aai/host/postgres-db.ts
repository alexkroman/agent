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
import { MAX_DB_RESULT_ROWS } from "../sdk/db.ts";

/** Options for {@link createPostgresDb}. */
export type CreatePostgresDbOptions = {
  /** Postgres connection URL (e.g. the app's `DATABASE_URL`). */
  url: string;
  /** Maximum pooled connections. Defaults to 4. */
  max?: number;
  /**
   * Drop the server notices raised by idempotent `IF NOT EXISTS` DDL
   * (`42P06` schema exists, `42P07` relation exists). The driver's default
   * handler `console.log`s the whole notice object, so a caller that
   * bootstraps its own schema on every boot — the platform stores — prints a
   * multi-line dump per statement per container, which buries real errors in
   * the log. Off by default: for `ctx.db` a tenant's `raise notice` is their
   * own debugging output and must keep flowing.
   */
  quietDdlNotices?: boolean;
};

/** Server-notice codes raised by `create ... if not exists` on a rerun. */
const ALREADY_EXISTS_NOTICE_CODES = new Set(["42P06", "42P07"]);

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
  const sql = postgres(opts.url, {
    max: opts.max ?? 4,
    prepare: false,
    ...(opts.quietDdlNotices && {
      onnotice: (notice) => {
        if (ALREADY_EXISTS_NOTICE_CODES.has(notice.code ?? "")) return;
        console.info(`postgres notice [${notice.code}] ${notice.message}`);
      },
    }),
  });
  return {
    async query<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]> {
      // The driver types parameters as its serializable union; `ctx.db` keeps
      // the caller-facing contract at `unknown[]` and lets the driver reject
      // non-serializable values at runtime.
      const rows = await sql.unsafe(query, (params ?? []) as postgres.ParameterOrJSON<never>[]);
      // Throw rather than truncate: a silently sliced result set is
      // indistinguishable from a complete one. One enforcement point keeps
      // `aai dev` and the platform's `db/query` RPC identical.
      if (rows.length > MAX_DB_RESULT_ROWS) {
        throw new Error(
          `query returned more than ${MAX_DB_RESULT_ROWS} rows; add a LIMIT (paginate with LIMIT/OFFSET)`,
        );
      }
      return [...rows] as T[];
    },
    async close(): Promise<void> {
      await sql.end();
    },
  };
}
