// Copyright 2026 the AAI authors. MIT license.
/**
 * Postgres-backed implementation of the SDK's {@link Db} capability.
 *
 * Wraps the `postgres` npm package behind the one-method `Db` contract that
 * tool `execute` code sees as `ctx.db`. `prepare: false` keeps the client
 * compatible with transaction-mode connection poolers (Supabase's Supavisor,
 * PgBouncer), which the platform fronts every app schema with.
 */

import type { Db } from "@alexkroman1/aai/internal";
import { MAX_DB_RESULT_ROWS } from "@alexkroman1/aai/internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import pTimeout from "p-timeout";
// TYPE-ONLY: the driver is loaded by `loadPostgres()` on first use. The named
// types below (`postgres.Sql`, `postgres.ReservedSql`, …) erase at compile
// time, so this import costs nothing at runtime.
import type postgres from "postgres";
import { consoleLogger } from "./runtime-config.ts";

/**
 * A query did not complete within its pool's deadline —
 * {@link CreatePostgresDbOptions.queryTimeoutMs} on the pooled path,
 * {@link CreatePostgresDbOptions.reservedQueryTimeoutMs} on a reservation.
 *
 * NOT exported: a platform caller maps this to a 503 by its stable `code`
 * (`"QUERY_TIMEOUT"`, added to `aai-server`'s `UNREACHABLE_CODES`), not by
 * `instanceof` — so it need not be public API, and keeping it off the barrel
 * avoids an epoch/report churn for an error type nobody constructs.
 *
 * This is the CLIENT-side bound a server `statement_timeout` cannot provide:
 * under a network partition the server's own cancellation notice is blackholed
 * with every other byte, so only the caller can decide the query has stalled.
 * A pool whose reservations hold advisory locks declares no reserved deadline
 * and is unwrapped there — those waits carry their own `lock_timeout` instead
 * (see `aai-server/platform-lock.ts`).
 */
class DbQueryTimeoutError extends Error {
  readonly code = "QUERY_TIMEOUT";
  constructor(milliseconds: number) {
    super(`Database query did not complete within ${milliseconds}ms`);
    this.name = "DbQueryTimeoutError";
  }
}

/**
 * The pool had no connection to RESERVE within
 * {@link CreatePostgresDbOptions.reserveTimeoutMs}.
 *
 * NOT exported, for the reason {@link DbQueryTimeoutError} is not: a platform
 * caller maps it by its stable `code` (`"POOL_EXHAUSTED"`, in `aai-server`'s
 * `UNREACHABLE_CODES`), never by `instanceof`.
 *
 * ## It is a distinct condition from a slow QUERY, and saying so is the point
 *
 * `sql.reserve()` queues indefinitely when every connection is taken, so at
 * exhaustion the wait was bounded by nothing here and the first deadline to fire
 * belonged to somebody else — the guest's 15s request timeout, four layers up.
 * The caller then saw "the journal did not answer", which is true and names the
 * wrong layer: nothing was wrong with the journal, the request never reached it.
 * A bounded wait can say what actually happened, and "no connection available"
 * is a 503 with a `Retry-After` where a timeout of unknown origin is a 500.
 *
 * The message names the deadline rather than the pool, matching the query
 * errors above: which bound elapsed is the actionable half, and a pool has no
 * name a reader would recognise.
 */
class DbPoolExhaustedError extends Error {
  readonly code = "POOL_EXHAUSTED";
  constructor(milliseconds: number) {
    super(`No pooled database connection became available within ${milliseconds}ms`);
    this.name = "DbPoolExhaustedError";
  }
}

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
  /**
   * Seconds to wait for a NEW connection to establish before failing. Unset
   * leaves postgres.js's own default (30). postgres.js raises `CONNECT_TIMEOUT`,
   * which a platform caller already maps to a 503 — so a partition that stalls
   * connection SETUP sheds load instead of hanging.
   */
  connectTimeoutSeconds?: number;
  /**
   * Client-side deadline, in milliseconds, for a query on a POOLED connection.
   * Unset leaves queries unbounded (the historic behaviour, correct for a
   * tenant `ctx.db`). On a stall the query rejects with a `QUERY_TIMEOUT`-coded
   * error — the only bound that survives a network partition, where a server
   * `statement_timeout`'s cancellation notice is blackholed with everything
   * else. RESERVED connections are bounded separately, by
   * {@link CreatePostgresDbOptions.reservedQueryTimeoutMs}.
   */
  queryTimeoutMs?: number;
  /**
   * The same deadline for a query on a RESERVED connection. Unset leaves a
   * reservation unbounded, which is the historic behaviour and stays the
   * DEFAULT.
   *
   * A separate option rather than {@link CreatePostgresDbOptions.queryTimeoutMs}
   * reaching both paths, because the two kinds of reservation want opposite
   * answers and only the POOL knows which kind it is:
   *
   * - A pool whose reservations hold an ADVISORY LOCK — `aai-server`'s slug-lock
   *   pool — must stay unbounded. That reservation is held for a whole deploy
   *   (blob uploads, a sandbox spawn), so a client-side deadline would abort
   *   deploys; the wait that does need a bound, the ACQUIRE, carries its own
   *   `lock_timeout` on the connection.
   * - A pool whose reservations are ordinary short statements — `aai-server`'s
   *   admin pool, which every guest platform route reserves from — must not be.
   *   Unbounded, four hung reads on a silently partitioned database exhaust that
   *   pool and every other platform read on the replica queues behind them.
   */
  reservedQueryTimeoutMs?: number;
  /**
   * Client-side deadline, in milliseconds, for ACQUIRING a reservation — the
   * wait BEFORE the connection is held, where the two options above bound a
   * statement running ON one. Unset leaves the wait unbounded, which is
   * postgres.js's own behaviour and stays the DEFAULT.
   *
   * Set it on a pool whose reservations are SHORT and unset it on one whose
   * reservations are long by construction — the same split
   * {@link CreatePostgresDbOptions.reservedQueryTimeoutMs} makes, and for a
   * sharper reason:
   *
   * - `aai-server`'s ADMIN pool holds a reservation for one guest platform
   *   request, so a wait past a few seconds means the pool is exhausted rather
   *   than busy. Unbounded, that wait is bounded by the CALLER's deadline
   *   instead, and the caller then reports a timeout against the wrong layer —
   *   see `DbPoolExhaustedError` in this module.
   * - `aai-server`'s SLUG-LOCK pool holds one for a whole deploy, so a fifth
   *   concurrent deploy legitimately waits minutes for a reservation and a
   *   deadline here would fail it. That pool takes neither bound.
   *
   * A wait that expires does NOT abandon the reservation: whichever connection
   * the driver eventually hands over is released, because a timed-out acquire
   * that let one leak would shrink the pool by one every time it fired — which
   * is the failure mode this option exists to relieve, made permanent.
   */
  reserveTimeoutMs?: number;
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
  /**
   * Subscribe to a Postgres `NOTIFY` channel. Resolves once the `LISTEN` is
   * established; the returned function unsubscribes.
   *
   * @internal
   *
   * A DEDICATED connection, outside the pool — postgres.js opens one per
   * listening handle and re-issues the `LISTEN` after a reconnect, which is the
   * half a hand-rolled version gets wrong. It therefore costs one connection per
   * replica and belongs in `platformDbConnectionsPerReplica`.
   *
   * **A notification is a HINT and must never be the only signal.** It is not
   * durable: anything committed while the listener was reconnecting is never
   * announced, and Postgres drops the payload rather than queueing it. So a
   * caller has to have a periodic pass that reaches the same work, and this only
   * removes the LATENCY of waiting for it. That is why the payload is not passed
   * through — a payload invites trusting the notification as the record.
   */
  listen(channel: string, onNotify: () => void): Promise<() => void>;
  /** Drain and close the connection pool. The handle must not be used after. */
  close(): Promise<void>;
};

/**
 * Take a reservation, giving up after `timeoutMs` rather than queueing forever.
 *
 * Its own function because the ABANDONED reservation is the whole subtlety.
 * `pTimeout` settles the caller and does nothing to the promise underneath, so
 * the driver still hands a connection over whenever one frees — and with nobody
 * left to release it, every expired wait would retire one connection from the
 * pool permanently. The late release is what keeps a shortage transient.
 *
 * `undefined` is the unbounded default, spelled as the absence of a deadline
 * rather than as a very large one: a pool that must never fail an acquire (the
 * slug lock's) is stating a property, not choosing a number.
 */
async function reserveWithin(
  sql: postgres.Sql,
  timeoutMs: number | undefined,
): Promise<postgres.ReservedSql> {
  if (timeoutMs === undefined) return await sql.reserve();
  const pending = sql.reserve();
  return await pTimeout(pending, {
    milliseconds: timeoutMs,
    fallback: () => {
      void pending.then(
        (late) => late.release(),
        () => undefined,
      );
      throw new DbPoolExhaustedError(timeoutMs);
    },
  });
}

/**
 * The driver, imported on first use and memoized.
 *
 * `postgres-db.ts` is re-exported from `runtime-barrel.ts`, so a static import
 * put the driver on the import path of every consumer of
 * `@alexkroman1/aai-runtime` — including `aai init` and `aai login`, which
 * never open a database. The promise is cached rather than the module, so two
 * concurrent first calls import once.
 */
let driver: Promise<typeof postgres> | undefined;
function loadPostgres(): Promise<typeof postgres> {
  driver ??= import("postgres").then((m) => m.default);
  return driver;
}

/**
 * Build the real handle. Split from {@link createPostgresDb} so that function
 * can stay SYNCHRONOUS — it is published, and every caller would otherwise
 * have to become async to buy a module load.
 */
async function buildPostgresDb(options: CreatePostgresDbOptions): Promise<CloseableDb> {
  const postgres = await loadPostgres();
  const sql = postgres(options.url, {
    max: options.max ?? 4,
    prepare: false,
    idle_timeout: options.idleTimeoutSeconds ?? POOL_IDLE_TIMEOUT_SECONDS,
    onnotice: options.onNotice ?? logNotice,
    ...omitUndefined({ connect_timeout: options.connectTimeoutSeconds }),
  });

  /**
   * The one query implementation, over the pool or a reserved connection.
   * Each path carries its OWN deadline, and a pool holding advisory locks
   * declares none for the reserved one — see `reservedQueryTimeoutMs`.
   */
  const queryOn =
    (on: Pick<postgres.Sql, "unsafe">, timeoutMs?: number) =>
    async <T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]> => {
      // The driver types parameters as its serializable union; `ctx.db` keeps
      // the caller-facing contract at `unknown[]` and lets the driver reject
      // non-serializable values at runtime.
      const run = on.unsafe(query, (params ?? []) as postgres.ParameterOrJSON<never>[]);
      const rows =
        timeoutMs === undefined
          ? await run
          : await pTimeout(run, {
              milliseconds: timeoutMs,
              fallback: () => {
                throw new DbQueryTimeoutError(timeoutMs);
              },
            });
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
    query: queryOn(sql, options.queryTimeoutMs),
    async reserve(): Promise<ReservedDb> {
      const reserved = await reserveWithin(sql, options.reserveTimeoutMs);
      return {
        query: queryOn(reserved, options.reservedQueryTimeoutMs),
        release: () => reserved.release(),
      };
    },
    async listen(channel: string, onNotify: () => void): Promise<() => void> {
      // The payload is DISCARDED rather than forwarded — see the type's doc. A
      // notification says "look again", and a caller that read state out of it
      // would be trusting a signal Postgres is allowed to drop.
      const subscription = await sql.listen(channel, () => onNotify());
      return () => {
        // `unlisten` is async and nothing here can wait: this is called from a
        // synchronous shutdown path, and the connection is closed by `close()`
        // moments later regardless. Reported rather than swallowed silently.
        void subscription.unlisten().catch((error: unknown) => {
          logNotice({ message: `unlisten(${channel}) failed: ${String(error)}` });
        });
      };
    },
    async close(): Promise<void> {
      await sql.end();
    },
  };
}

/**
 * Create a {@link Db} backed by a Postgres connection pool.
 *
 * Connections open lazily on first query, so constructing the handle is
 * cheap and never touches the network — and now neither does it load the
 * driver, which is the same promise one level up (see {@link loadPostgres}).
 *
 * `close()` on a handle that was never used resolves without loading anything:
 * a caller tearing down a pool it never queried must not pay for the import.
 *
 * @public
 */
export function createPostgresDb(options: CreatePostgresDbOptions): CloseableDb {
  let pending: Promise<CloseableDb> | undefined;
  const db = (): Promise<CloseableDb> => {
    pending ??= buildPostgresDb(options);
    return pending;
  };
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      return (await db()).query<T>(sql, params);
    },
    async reserve(): Promise<ReservedDb> {
      return (await db()).reserve();
    },
    async listen(channel: string, onNotify: () => void): Promise<() => void> {
      return (await db()).listen(channel, onNotify);
    },
    async close(): Promise<void> {
      if (pending === undefined) return;
      await (await pending).close();
    },
  };
}
