// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:db` epoch 1.
 *
 * **"Frozen" means this file must keep compiling against current source for as
 * long as epoch 1 is advertised as supported.** A compile error here is the
 * finding, not something to edit away. Imports are RELATIVE
 * (`../../../runtime-barrel.ts`) because the package cannot resolve itself by
 * name, and `contracts/` is excluded from the declaration emit and from the
 * tarball.
 *
 * An agent's Postgres handle, and the thing this capability is really shaped
 * around: **there are two handles and they are closed by different people.**
 *
 * - A {@link CloseableDb} owns a connection POOL. Whoever created it closes it,
 *   once, at shutdown — and nobody else may, because every session on this
 *   process is querying through it.
 * - A {@link ReservedDb} is one connection held OUT of that pool. Whoever
 *   reserved it releases it in a `finally`, and releasing is not closing: a
 *   leaked reservation permanently shrinks the pool by one and the symptom
 *   arrives much later, as a process that queries fine until it does not.
 *
 * A reservation exists for the one thing a pool cannot express: SESSION-scoped
 * state. `query` gives no connection affinity, so a `pg_advisory_lock` and its
 * `pg_advisory_unlock` can land on different connections and leave the lock held
 * by an idle pool member forever — which is why the lock and the unlock below
 * are both issued on the reserved handle and never on `db`.
 */

import {
  type CloseableDb,
  type CreatePostgresDbOptions,
  createPostgresDb,
  type ReservedDb,
  type SweepSkip,
} from "../../../runtime-barrel.ts";

/**
 * Open the pool one host process serves every session from.
 *
 * Constructing it is cheap and never touches the network — connections open
 * lazily on the first query — so this belongs at boot rather than behind a
 * first-use check.
 *
 * `onNotice` is passed rather than left to the driver's default, which prints
 * the whole notice OBJECT to the console: the session-state backend's
 * idempotent `create table if not exists` then dumps a `42P07` blob into the
 * log an operator reads to diagnose a session, on every boot, which trains that
 * reader to skip NOTICEs — and skipping them is where a notice that MATTERS
 * would have arrived.
 */
export function openAppDb(url: string, notice: (message: string) => void): CloseableDb {
  const opts: CreatePostgresDbOptions = {
    url,
    max: 4,
    // A pool's cost is its HIGH-WATER MARK rather than what it is using: on a
    // platform every connection is charged against the app role's limit, and two
    // sandboxes for one agent legitimately overlap while a replaced one drains.
    idleTimeoutSeconds: 30,
    onNotice: (raw) => notice(String(raw)),
  };
  return createPostgresDb(opts);
}

/**
 * Run something under a Postgres advisory lock, on ONE connection.
 *
 * The `finally` is the whole point, and it does two separate things in the right
 * order: unlock on the connection that locked, then hand that connection back.
 * Doing only the second leaves a lock held by a pool member nothing will ask
 * again; doing only the first shrinks the pool.
 *
 * Note the idle timeout above cannot reclaim this connection while it is
 * reserved — the driver starts that timer only for a connection returned to the
 * pool's open queue — which is what makes a session-lifetime lock safe to hold
 * across an otherwise quiet stretch.
 */
export async function withAdvisoryLock<T>(
  db: CloseableDb,
  lockId: number,
  run: (held: ReservedDb) => Promise<T>,
): Promise<T> {
  const held: ReservedDb = await db.reserve();
  try {
    await held.query("select pg_advisory_lock($1)", [lockId]);
    return await run(held);
  } finally {
    await held.query("select pg_advisory_unlock($1)", [lockId]);
    held.release();
  }
}

/**
 * Whether this process could take the lock at all, without waiting for it.
 *
 * The shape a startup sweep wants: a second process holding presence is a
 * NORMAL outcome, not a failure, so it must be answerable rather than waited
 * out. `pg_try_advisory_lock` answers a boolean, and the reservation is released
 * on the arm that did not get it — a connection held for a lock we do not have
 * is pure loss.
 */
export async function tryTakePresence(
  db: CloseableDb,
  lockId: number,
): Promise<ReservedDb | undefined> {
  const held = await db.reserve();
  const rows = await held.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [
    lockId,
  ]);
  if (rows[0]?.locked === true) return held;
  held.release();
  return undefined;
}

/**
 * Say why a startup sweep cleared nothing, for the log an operator reads.
 *
 * Both values are healthy and they are healthy for different reasons, which is
 * exactly why this is a union of two names rather than a boolean: "another pool
 * is live" means the locks it found are somebody's and not ours to clear, and
 * "no orphaned locks" means it held presence and there was nothing to do. A
 * sweep that reports neither DID clear something, which is the line worth
 * noticing.
 */
export function describeSweep(skip: SweepSkip | undefined, cleared: readonly string[]): string {
  switch (skip) {
    case "another-pool-is-live":
      return "another pool holds presence; its queue locks are live";
    case "no-orphaned-locks":
      return "presence held, nothing was locked";
    default:
      return `cleared ${cleared.length} orphaned queue lock(s)`;
  }
}

/**
 * Shut the process down.
 *
 * Closing drains the pool and the handle must not be used afterwards, so this
 * runs once, from whoever opened it, after every session is done with it — never
 * from a session, and never in the `finally` of a piece of work.
 */
export async function closeAppDb(db: CloseableDb): Promise<void> {
  await db.close();
}
