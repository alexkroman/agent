// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:db` epoch 6.
 *
 * A host bounding the two waits a RESERVATION can impose, which is the pair
 * epoch 6 completed and epoch 7 extends. `v5.ts` configures the pool and takes
 * a reservation to hold an advisory lock; this one is the other half — the
 * short-statement reservation, where an unbounded wait is a bug rather than a
 * feature. Written the way it was authored at epoch 6, and it must keep
 * compiling for as long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 6 survives it
 *
 * Epoch 7 added an optional `reserveTimeoutMs` to `CreatePostgresDbOptions`: a
 * bound on WAITING for a connection, where epoch 6's `reservedQueryTimeoutMs`
 * bounds the QUERY once you hold one. They are different failures and want
 * different numbers — the query bound catches a partitioned server that
 * accepted your statement and went quiet, while the wait bound catches a pool
 * whose four connections are all held by someone else. A pool can want either,
 * both, or neither.
 *
 * Adding an OPTIONAL member to a bag the caller SUPPLIES is not breaking,
 * which is what makes this a retain: every bag below is still a legal
 * `CreatePostgresDbOptions`, and a host that names no wait bound gets the
 * indefinite queue it always had. `v5.ts` records the same reasoning for the
 * epoch-5 → 6 step, and the direction that WOULD break is unchanged — a
 * REQUIRED member on that bag, or a new member on `CloseableDb`, which every
 * IMPLEMENTOR would owe immediately.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 6 has to be dropped with a reason.
 */

import type { CloseableDb, CreatePostgresDbOptions, ReservedDb } from "../../../runtime-barrel.ts";
import { createPostgresDb } from "../../../runtime-barrel.ts";

/**
 * ── EDIT: a pool whose reservations are ORDINARY SHORT STATEMENTS. ───────
 *
 * The distinction that decides `reservedQueryTimeoutMs` is what the caller
 * does while holding the connection, and only the host knows:
 *
 * - A reservation that holds an advisory lock across a whole deploy must stay
 *   UNBOUNDED, or a client-side deadline aborts deploys that are working.
 *   That pool leaves this unset — see `v5.ts`.
 * - A reservation that runs a couple of short statements must be bounded, or
 *   four hung reads against a silently partitioned server take every
 *   connection and each later reader queues behind them forever.
 *
 * `queryTimeoutMs` does not reach the second case: it bounds a POOLED query,
 * and a reservation is by definition off the pool.
 */
export function shortStatementPoolOptions(url: string): CreatePostgresDbOptions {
  return {
    url,
    max: 4,
    idleTimeoutSeconds: 30,
    connectTimeoutSeconds: 10,
    queryTimeoutMs: 5000,
    reservedQueryTimeoutMs: 5000,
  };
}

/** The handle a host holds for the life of the process, and must close. */
export function openShortStatementPool(url: string): CloseableDb {
  return createPostgresDb(shortStatementPoolOptions(url));
}

/**
 * Read a session's slots on ONE connection, so the two statements agree.
 *
 * `release()` is in a `finally` because that is the whole contract of a
 * reservation: a path that throws without releasing retires one connection of
 * `max` permanently, and four such paths retire the pool.
 */
export async function readSlotsTogether(
  db: CloseableDb,
  sessionId: string,
): Promise<readonly string[]> {
  const reserved: ReservedDb = await db.reserve();
  try {
    await reserved.query("set local statement_timeout = '5s'");
    const rows = await reserved.query<{ slot: string }>(
      "select slot from aai_session_state where session_id = $1 order by slot",
      [sessionId],
    );
    return rows.map((row) => row.slot);
  } finally {
    reserved.release();
  }
}

/** A host closes the pool it opened; nothing else can. */
export async function shutdown(db: CloseableDb): Promise<void> {
  await db.close();
}
