// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:db` epoch 5.
 *
 * A host CONFIGURING the pool rather than merely opening one — the whole
 * options bag as epoch 5 declared it, plus the `NOTIFY` subscription. That is
 * the half `v2.ts` does not reach: it opens `{ url, max }` and uses the handle,
 * which is the shape a self-hosted `createServer` copies, where this is the
 * shape a host that RUNS the platform's own database copies. Written the way it
 * was authored at epoch 5, and it must keep compiling for as long as that epoch
 * is advertised as supported.
 *
 * ## What moved, and why epoch 5 survives it
 *
 * Epoch 6 added an optional `reservedQueryTimeoutMs` to
 * `CreatePostgresDbOptions`: the same client-side deadline `queryTimeoutMs`
 * puts on a POOLED query, for a query on a RESERVATION.
 *
 * It is a separate option rather than one number reaching both paths because
 * the two kinds of reservation want opposite answers and only the pool knows
 * which kind it is. A pool whose reservations hold an advisory lock across a
 * whole deploy must stay unbounded, or a client-side deadline aborts deploys;
 * a pool whose reservations are ordinary short statements must not be, or four
 * hung reads against a silently partitioned database exhaust it and every
 * other read queues behind them. Unset stays the default on both counts, which
 * is the historic behaviour.
 *
 * Adding an OPTIONAL member to a bag the caller SUPPLIES is not breaking,
 * which is what makes this a retain: every bag below is still a legal
 * `CreatePostgresDbOptions`, and a host that names neither timeout gets the
 * unbounded pool it always had.
 *
 * **The direction that WOULD break is a REQUIRED member on that bag** — every
 * host assembling one owes it immediately — and, as `v2.ts` records, an
 * IMPLEMENTOR of `CloseableDb`. This file is neither: it supplies options and
 * consumes the handle, which is the pair this capability actually promises.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 5 has to be dropped with a reason.
 */

import type { CloseableDb, CreatePostgresDbOptions, ReservedDb } from "../../../runtime-barrel.ts";
import { createPostgresDb } from "../../../runtime-barrel.ts";

/**
 * ── EDIT: the pool this replica opens for its own reads. ─────────────────
 *
 * Every field is a decision a host sharing a database with anything else has
 * to make, which is why they are named rather than defaulted:
 *
 * - `max` is charged against the role's `connection limit`, and a pool's cost
 *   is its HIGH-WATER MARK rather than what it is using.
 * - `idleTimeoutSeconds` is what returns that headroom. The driver never
 *   closes an idle connection for being idle on its own.
 * - `connectTimeoutSeconds` bounds connection SETUP, so a partition that
 *   stalls the handshake sheds load instead of hanging.
 * - `queryTimeoutMs` bounds a POOLED query, and is the only bound that
 *   survives a partition: a server-side `statement_timeout` cancels by
 *   sending a notice down the same blackholed socket.
 * - `onNotice` because the driver has no quiet default — unset, it prints the
 *   whole notice OBJECT, and a `create table if not exists` we run
 *   deliberately on every boot dumps a `42P07` blob into the log an operator
 *   reads to diagnose something else.
 */
export function adminPoolOptions(url: string): CreatePostgresDbOptions {
  return {
    url,
    max: 4,
    idleTimeoutSeconds: 30,
    connectTimeoutSeconds: 10,
    queryTimeoutMs: 5000,
    onNotice: (notice) => {
      console.debug("postgres notice", notice);
    },
  };
}

/** The handle a host holds for the life of the process, and must close. */
export function openAdminPool(url: string): CloseableDb {
  // Connections open LAZILY on the first query, so constructing this never
  // touches the network and a boot cannot fail on it.
  return createPostgresDb(adminPoolOptions(url));
}

/**
 * Read one row through the pool.
 *
 * The generic is on the call rather than on a cast afterwards, which is the
 * point of it being there: a shape that has since moved reddens here, where a
 * cast would have compiled against a column that no longer exists.
 */
export async function countRuns(db: CloseableDb, workflow: string): Promise<number> {
  const rows = await db.query<{ total: number }>(
    "select count(*)::int as total from aai_workflow_runs where workflow = $1",
    [workflow],
  );
  return rows[0]?.total ?? 0;
}

/**
 * Do the one thing a pooled query cannot: hold a connection across statements.
 *
 * A `set local` and an advisory lock are both SESSION-scoped, and the pooled
 * `query` gives no connection affinity — so a `pg_advisory_lock` and its
 * unlock can land on different members, leaving a lock held by an idle
 * connection forever. Released in a `finally`, because a leaked reservation
 * permanently shrinks the pool.
 */
export async function withReservation<T>(
  db: CloseableDb,
  work: (reserved: ReservedDb) => Promise<T>,
): Promise<T> {
  const reserved: ReservedDb = await db.reserve();
  try {
    // The bound that belongs on the WAIT rather than on the pool: this is the
    // acquire, and an operator wants it to fail rather than queue.
    await reserved.query("set local lock_timeout = '5s'");
    return await work(reserved);
  } finally {
    reserved.release();
  }
}

/**
 * Subscribe to a `NOTIFY` channel, and treat the notification as a HINT.
 *
 * The subscription costs one connection per replica, outside the pool — the
 * driver opens a dedicated one per listening handle and re-issues the `LISTEN`
 * after a reconnect, which is the half a hand-rolled version gets wrong.
 *
 * **It must never be the only signal.** A notification is not durable:
 * anything committed while the listener was reconnecting is never announced,
 * and Postgres drops the payload rather than queueing it. So the caller keeps
 * its periodic pass and this only removes the LATENCY of waiting for one —
 * which is also why no payload is passed through, a payload being an
 * invitation to trust the notification as the record.
 */
export async function watchQueue(db: CloseableDb, wake: () => void): Promise<() => void> {
  return await db.listen("aai_workflow_queue", wake);
}

/** ── EDIT: the shutdown your process already has. ───────────────────────── */
export async function closeAdminPool(db: CloseableDb): Promise<void> {
  await db.close();
}
