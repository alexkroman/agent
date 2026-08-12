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
};

/**
 * One connection held out of the pool for the caller's exclusive use, so
 * SESSION-scoped state — advisory locks, `SET` — survives across statements.
 *
 * @public
 */
export type ReservedDb = Db & {
  /** Return the connection to the pool. Idempotent; the handle dies with it. */
  release(): void;
};

/** A {@link Db} whose underlying connection pool the caller owns and must close. */
export type CloseableDb = Db & {
  /**
   * Hold one connection out of the pool until `release()`.
   *
   * @internal
   *
   * The pooled `query` above gives no connection affinity, which makes every
   * session-scoped Postgres feature unusable through it: a
   * `pg_advisory_lock` and its `pg_advisory_unlock` can land on different
   * connections, leaving a lock held by an idle pool member forever. Callers
   * that need affinity take one of these instead and must release it in a
   * `finally` — a leaked reservation permanently shrinks the pool.
   */
  reserve(): Promise<ReservedDb>;
  /** Drain and close the connection pool. The handle must not be used after. */
  close(): Promise<void>;
};

/**
 * SQLSTATEs an `IF NOT EXISTS` raises when the object is already there.
 *
 * `42P07` is duplicate_table (also duplicate_index — Postgres reuses it for
 * every relation kind), `42710` is duplicate_object, which the same idiom raises
 * for types and constraints, and `42701` is duplicate_COLUMN, raised by
 * `alter table … add column if not exists`.
 *
 * That last one was missing, and the store it belongs to runs such a statement on
 * every boot: `ADD_RUNS_KEY` (`workflow-store.ts`) adds `correlation_key` to a
 * journal that predates the column, so every engine after the very first one
 * logged `column "correlation_key" of relation "aai_workflow_runs" already
 * exists` — the exact noise this filter exists to remove, from the exact caller
 * it was written for. Found by running the durability suite against a real
 * Postgres and reading the output; no unit test can see it, because the notice
 * comes from the driver rather than from our code.
 */
const EXPECTED_NOTICE_CODES = new Set(["42P07", "42710", "42701"]);

/**
 * postgres.js's notice handler.
 *
 * The default prints every NOTICE to stdout as a six-line object, and the ones
 * this driver actually produces are all self-inflicted: the workflow store
 * ensures its schema with `create table if not exists` on every boot (five
 * notices), and an agent doing the same for its own table adds one per run —
 * `transcription-desk`'s `save` step is the worked example. Under the guest's
 * log relay they reach the platform log too.
 *
 * **`IF NOT EXISTS` is a declaration that a no-op is expected**, so the notice
 * it raises is expected output rather than information, and six of them per
 * boot crowd out the line someone opened the log for. Filtered on the SQLSTATE
 * rather than by silencing `onnotice` altogether: a NOTICE nobody asked for —
 * a truncated identifier, a deprecated cast — is the kind of thing worth
 * seeing, and swallowing the whole channel to quiet a known-benign subset is
 * how a real warning goes missing.
 */
function reportNotice(notice: postgres.Notice): void {
  if (notice.code !== undefined && EXPECTED_NOTICE_CODES.has(notice.code)) return;
  console.warn(`[postgres] ${notice.severity ?? "NOTICE"}: ${notice.message}`);
}

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
    onnotice: reportNotice,
  });

  /** The one query implementation, over the pool or a reserved connection. */
  const queryOn =
    (on: Pick<postgres.Sql, "unsafe">) =>
    async <T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]> => {
      // The driver types parameters as its serializable union; `ctx.db` keeps
      // the caller-facing contract at `unknown[]` and lets the driver reject
      // non-serializable values at runtime.
      const rows = await on.unsafe(query, (params ?? []) as postgres.ParameterOrJSON<never>[]);
      // Throw rather than truncate: a silently sliced result set is
      // indistinguishable from a complete one. One enforcement point keeps
      // `aai dev` and the platform's `db/query` RPC identical.
      if (rows.length > MAX_DB_RESULT_ROWS) {
        throw new Error(
          `query returned more than ${MAX_DB_RESULT_ROWS} rows; add a LIMIT (paginate with LIMIT/OFFSET)`,
        );
      }
      return [...rows] as T[];
    };

  return {
    query: queryOn(sql),
    async reserve(): Promise<ReservedDb> {
      const reserved = await sql.reserve();
      return { query: queryOn(reserved), release: () => reserved.release() };
    },
    async close(): Promise<void> {
      await sql.end();
    },
  };
}
