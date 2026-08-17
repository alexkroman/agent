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
import { consoleLogger } from "./runtime-config.ts";

/**
 * The default notice sink: quiet, but not swallowed.
 *
 * `consoleLogger.debug` is itself a no-op unless `AAI_DEBUG=1`, so a NOTICE
 * prints nothing in an ordinary run and one line under a debug flag. That split
 * is the whole point: `42P07` ("relation … already exists, skipping") is one we
 * cause deliberately on every boot (`create table if not exists`, memoized by
 * `ensureOnce`), so it must not be in the log an operator reads to diagnose a
 * session — while a notice that MATTERS (a truncated identifier, a deprecated
 * cast, a constraint silently declined) is still recoverable rather than
 * discarded by a sink that ignores its argument.
 */
function logNotice(notice: unknown): void {
  const { severity, code, message } = (notice ?? {}) as {
    severity?: unknown;
    code?: unknown;
    message?: unknown;
  };
  consoleLogger.debug?.(`postgres ${String(severity ?? "NOTICE")} ${String(code ?? "")}`.trim(), {
    message: String(message ?? notice),
  });
}

/** Options for {@link createPostgresDb}. */
export type CreatePostgresDbOptions = {
  /** Postgres connection URL (e.g. the app's `DATABASE_URL`). */
  url: string;
  /** Maximum pooled connections. Defaults to 4. */
  max?: number;
  /**
   * Where Postgres NOTICEs go. Defaults to one `debug` line each.
   *
   * postgres.js has no silent default: with this unset it prints the whole
   * notice OBJECT to the console, so the session-state backend's own
   * `create table if not exists` — idempotent by design, run once per boot per
   * table (`ensureOnce`) — dumped an eight-field `42P07` blob into a guest's
   * stdout on every single boot. Two costs, and the second is the real one: it
   * is noise in the log an operator reads to diagnose a session, and it trains
   * that reader to skip NOTICEs, which is where a notice that MATTERS would
   * arrive.
   */
  onNotice?: (notice: unknown) => void;
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
    onnotice: opts.onNotice ?? logNotice,
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
