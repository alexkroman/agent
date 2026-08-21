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

/**
 * How long a pooled connection may sit unused before it is closed, in seconds.
 *
 * postgres.js never closes an idle connection for being idle by default
 * (`idle_timeout: null`; its `max_lifetime` recycles one every 30-60 minutes and
 * reopens it on the next query, which is not the same thing). So a pool's cost is
 * its HIGH-WATER MARK rather than what it is using — and on the platform every
 * one of those connections is charged against the app role's `connection limit`
 * (`sdk/app-db-budget.ts`). Two sandboxes for one agent legitimately overlap
 * while a replaced one drains, and the resident half of that overlap is what
 * decides whether the new guest can connect at all.
 *
 * 30 seconds: long enough that a busy pool never reconnects mid-conversation
 * (a session's queries are seconds apart at worst), short enough that a guest
 * which served a burst and went quiet is not still holding the burst's
 * connections when its replacement boots.
 *
 * **A RESERVED connection is unaffected**, which is what makes this safe for the
 * one thing in the repo that depends on session lifetime — the workflow lock
 * sweep's advisory lock. postgres.js starts the idle timer only when a
 * connection is returned to the pool's `open` queue and cancels it for anything
 * moved elsewhere (`move()` in the driver, 3.4.9), and a reservation lives in
 * the `reserved` queue until it is released.
 */
const POOL_IDLE_TIMEOUT_SECONDS = 30;

/** Options for {@link createPostgresDb}. */
export type CreatePostgresDbOptions = {
  /** Postgres connection URL (e.g. the app's `DATABASE_URL`). */
  url: string;
  /** Maximum pooled connections. Defaults to 4. */
  max?: number;
  /**
   * Seconds an unused pooled connection is kept. Defaults to 30 — see
   * `POOL_IDLE_TIMEOUT_SECONDS` in this module for why there is a default at
   * all. Named rather than linked on purpose: that constant is module-private,
   * and a doc link from this PUBLISHED signature to it fails the docs build
   * (TypeDoc runs with `treatWarningsAsErrors`).
   *
   * `0` keeps every connection for the life of the pool, which is postgres.js's
   * own default and is only right for a pool whose connections are all
   * long-lived by construction.
   */
  idleTimeoutSeconds?: number;
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
    idle_timeout: opts.idleTimeoutSeconds ?? POOL_IDLE_TIMEOUT_SECONDS,
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
