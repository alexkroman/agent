// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-1 TEMPLATE for `aai-runtime:db` — the app-database starter as it was
 * written at epoch 1. Copy this file into your own host and edit the marked
 * points; it is meant to be taken, not read.
 *
 * **FROZEN.** This copy must keep compiling against current source for as long
 * as epoch 1 is supported, so a compile error here is the finding — never
 * something to edit away. Changing the API means a NEW epoch carrying a new
 * template, never an edit to this one. Imports are relative
 * (`../../../runtime-barrel.ts`) because the package cannot resolve itself by
 * name.
 *
 * ## What this is
 *
 * One host's database bootstrap, in the order a host does it: open the pool
 * once at boot, reserve a connection per lock while it runs, close the pool
 * once at shutdown.
 *
 * ## What to change
 *
 * - {@link APP_DB_URL_ENV} — your connection-string variable.
 * - {@link APP_DB_POOL_MAX} and {@link APP_DB_IDLE_TIMEOUT_SECONDS} — your
 *   share of the role's `connection limit`.
 * - The `undefined` arm of {@link startAppDb} — decide what "no database
 *   configured" means for your host: degrade, or refuse to boot.
 * - The `log` sink, and the lock ids you pass to `withLock`.
 *
 * ## What not to change
 *
 * The body of {@link withAppDbLock}, and specifically its order: reserve, lock,
 * run, then in a `finally` UNLOCK FIRST and release SECOND. This is the part a
 * copier gets wrong.
 *
 * - Locking on `db` instead of on the reserved handle: `query` gives no
 *   connection affinity, so the `pg_advisory_unlock` can land on a different
 *   connection than the lock did and leave the lock held by an idle pool member
 *   forever.
 * - Releasing without unlocking: same outcome — a lock nothing will ever ask
 *   for again.
 * - Unlocking without releasing: the pool permanently shrinks by one
 *   connection, and the symptom arrives much later as a process that queries
 *   fine until it does not.
 *
 * Closing is not releasing. `close()` drains the whole pool and belongs only to
 * whoever opened it, once, at shutdown — never in the `finally` of a piece of
 * work and never from a session.
 */

import {
  type CloseableDb,
  type CreatePostgresDbOptions,
  createPostgresDb,
  type ReservedDb,
} from "../../../runtime-barrel.ts";

/** Environment variable naming the app database. ← your variable. */
export const APP_DB_URL_ENV = "DATABASE_URL";

/**
 * Connections this process may hold at once. ← your share.
 *
 * A pool costs its HIGH-WATER MARK rather than what it is using, and every
 * connection is charged against the role's `connection limit`, so size this
 * against every other process on the same role.
 */
export const APP_DB_POOL_MAX = 4;

/** How long an idle pooled connection is kept before the driver drops it. */
export const APP_DB_IDLE_TIMEOUT_SECONDS = 30;

/** What a host holds for the life of the process. */
export type AppDb = {
  /** The pool every session queries through. Do not call `close()` on it. */
  readonly db: CloseableDb;
  /** Run something under a Postgres advisory lock, on one connection. */
  withLock<T>(lockId: number, run: (held: ReservedDb) => Promise<T>): Promise<T>;
  /** Drain the pool. Once, at shutdown. */
  shutdown(): Promise<void>;
};

/**
 * Open the pool this process serves every session from. Call it once, at boot.
 *
 * Constructing it is cheap and touches no network — connections open lazily on
 * the first query — so this belongs at boot rather than behind a first-use
 * check.
 *
 * Pass `onNotice`. The driver's default prints the whole notice OBJECT, so an
 * idempotent `create table if not exists` dumps a `42P07` blob into the log on
 * every boot, which trains an operator to skip NOTICEs — and skipping them is
 * where a notice that matters would have arrived.
 *
 * `undefined` here means the environment named no database. ← decide what that
 * means for your host: this arm degrades, and a host that cannot run without
 * one should throw instead.
 */
export function startAppDb(
  env: Record<string, string | undefined>,
  log: (message: string) => void,
): AppDb | undefined {
  const url = env[APP_DB_URL_ENV]?.trim();
  if (!url) {
    log(`${APP_DB_URL_ENV} is unset; running without an app database`);
    return undefined;
  }
  const opts: CreatePostgresDbOptions = {
    url,
    max: APP_DB_POOL_MAX,
    idleTimeoutSeconds: APP_DB_IDLE_TIMEOUT_SECONDS,
    onNotice: (notice) => log(`postgres notice: ${String(notice)}`),
  };
  const db = createPostgresDb(opts);
  return {
    db,
    withLock<T>(lockId: number, run: (held: ReservedDb) => Promise<T>): Promise<T> {
      return withAppDbLock(db, lockId, run);
    },
    shutdown(): Promise<void> {
      return db.close();
    },
  };
}

/**
 * Reserve one connection, hold an advisory lock on it, and give both back.
 *
 * A reservation exists for the one thing a pool cannot express: SESSION-scoped
 * state, which an advisory lock is. See the module doc for what breaks if you
 * reorder the `finally`.
 *
 * The idle timeout above cannot reclaim a reserved connection — the driver
 * starts that timer only for a connection returned to the pool — which is what
 * makes a long-held lock safe across a quiet stretch.
 */
export async function withAppDbLock<T>(
  db: CloseableDb,
  lockId: number,
  run: (held: ReservedDb) => Promise<T>,
): Promise<T> {
  const held: ReservedDb = await db.reserve();
  try {
    await held.query("select pg_advisory_lock($1)", [lockId]);
    return await run(held);
  } finally {
    // Unlock on the connection that locked it, THEN hand that connection back.
    await held.query("select pg_advisory_unlock($1)", [lockId]);
    held.release();
  }
}

/**
 * What the lock protects — ← your work, and ← your table.
 *
 * Everything inside runs on `held`, the one connection that owns the lock.
 * Queries that do not need the lock should go to the pool (`app.db.query`)
 * instead, so they are not serialized behind it.
 */
export async function withMigrationLock(app: AppDb, lockId: number): Promise<number> {
  return await app.withLock(lockId, async (held) => {
    const rows = await held.query<{ version: number }>(
      "select coalesce(max(version), 0) as version from schema_version",
    );
    return rows[0]?.version ?? 0;
  });
}

/**
 * Shut the process down.
 *
 * After this the handle must not be used, so run it once, from whoever opened
 * the pool, after every session is done with it.
 */
export async function stopAppDb(app: AppDb | undefined): Promise<void> {
  await app?.shutdown();
}
