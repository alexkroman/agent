// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:db` epoch 2.
 *
 * A host OPENING a platform database and using the handle — which is what this
 * capability is for, and what a self-hosted `createServer` copies. Written the way
 * it was authored at epoch 2, and it must keep compiling for as long as that
 * epoch is advertised as supported.
 *
 * ## What moved, and why epoch 2 survives it
 *
 * Epoch 3 added a required `listen(channel, onNotify)` to `CloseableDb`: the
 * durable-workflow queue announces on a Postgres `NOTIFY` channel so a step-to-step
 * hop stops paying the poll interval, and a `LISTEN` needs a dedicated connection
 * the pooled `query` cannot hold.
 *
 * Adding a member to a type a caller RECEIVES is not breaking, which is what makes
 * this a retain: everything below still compiles, and a host that ignores `listen`
 * gets the same handle it always had.
 *
 * **The direction that WOULD break is an IMPLEMENTOR** — a host supplying its own
 * object as a `CloseableDb` now owes a `listen`. That is deliberately not what this
 * example does, and the distinction is the whole reason the epoch is retained
 * rather than dropped: this capability's promise is `createPostgresDb` and the
 * shape of what it returns, not the ability to substitute a hand-written handle.
 * A host that really does implement the interface is on the unversioned side of
 * that line and should expect to track it.
 *
 * Editing this file to make a future error go away defeats the mechanism: the error
 * IS the finding, and it means epoch 2 has to be dropped with a reason.
 */

import type { CloseableDb, ReservedDb } from "../../../runtime-barrel.ts";
import { createPostgresDb } from "../../../runtime-barrel.ts";

/**
 * Open a pool, read through it, and close it — the whole ordinary path.
 *
 * The `max` is named rather than defaulted because a host sharing an instance with
 * anything else has to decide it; the SDK's own default assumes it owns the
 * database.
 */
export async function readThroughAPool(url: string): Promise<number> {
  const db: CloseableDb = createPostgresDb({ url, max: 2 });
  try {
    const rows = await db.query<{ n: number }>("select 1::int as n");
    return rows[0]?.n ?? 0;
  } finally {
    await db.close();
  }
}

/**
 * Hold ONE connection across a critical section.
 *
 * The reason this member exists: a session-scoped Postgres feature — an advisory
 * lock, a `set local` — needs connection affinity, and the pooled `query` gives
 * none. Released in a `finally`, because a leaked reservation permanently shrinks
 * the pool.
 */
export async function withOneConnection(url: string): Promise<void> {
  const db = createPostgresDb({ url, max: 2 });
  try {
    const reserved: ReservedDb = await db.reserve();
    try {
      await reserved.query("select pg_advisory_lock($1::int, $2::int)", [1, 2]);
      await reserved.query("select pg_advisory_unlock($1::int, $2::int)", [1, 2]);
    } finally {
      reserved.release();
    }
  } finally {
    await db.close();
  }
}
