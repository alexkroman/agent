// Copyright 2026 the AAI authors. MIT license.
/**
 * Clear the queue locks no live worker pool owns, once, at startup.
 *
 * ## The wedge this exists for
 *
 * `@workflow/world-postgres` runs graphile-worker with `concurrency: 10`, so the
 * pool holds ten workers each with its own `worker-<id>`. A job claimed when the
 * process dies keeps `locked_by` that worker — and `get_job` selects on
 * `is_available = true`, which a locked row is not — so the replacement pool
 * polls straight past it. Recovery waits on graphile-worker's own reclaim window,
 * `interval '4 hours'`; nothing sets `jobExpiry`.
 *
 * Measured: ONE hard kill (of the process, or of its Postgres) strands every
 * in-flight step of a `transcription-desk` run, with the run sitting `running`
 * and the page showing "Working…" indefinitely. A repeated-kill soak wedged 4 of
 * 4 runs. Journal replay is correct throughout — completed steps are never
 * re-executed and nothing is re-billed — so the defect is redelivery, not replay,
 * and this is the redelivery half.
 *
 * ## Why a startup sweep is SAFE, and what makes it safe
 *
 * Unlocking a job a LIVE worker is executing runs that step twice concurrently,
 * which is a worse defect than the one being fixed. So the sweep needs to know
 * that no other pool is alive, and it cannot ask graphile-worker: there is no
 * worker registry, and `world-postgres` calls `run()` with a closed option set,
 * so this package cannot even name its own pool's worker ids.
 *
 * A **session advisory lock** answers it exactly, with no table, no heartbeat and
 * no staleness threshold to tune:
 *
 * - At startup, before the runner begins polling, this pool holds ZERO locks — so
 *   every lock in the database belongs to somebody else.
 * - `pg_try_advisory_lock` succeeds only if no other session holds it. Postgres
 *   releases a session lock when the connection dies, so a SIGKILLed predecessor
 *   has already given it up and a live sibling has not.
 * - So: lock acquired ⇒ we are the only pool ⇒ every lock present is an orphan.
 *   Lock refused ⇒ a live pool exists ⇒ sweep NOTHING and say so.
 *
 * The case that makes this non-theoretical rather than paranoia: an app database
 * is scoped per SLUG (`app_<sha256(slug)>`), so preview and production never
 * share one — but a developer running `aai dev` with a production `DATABASE_URL`
 * in `.env` does, and a blanket startup sweep would reach into the deployed
 * agent's in-flight steps. The advisory lock makes that case skip.
 *
 * ## What it does NOT cover
 *
 * **A Postgres outage under a process that survives it.** No process restarts, so
 * no sweep runs, and the locks that outage orphaned stay orphaned. Covering it
 * needs a PERIODIC sweep, which needs to tell this pool's live locks from its own
 * orphaned ones — i.e. the worker-id attribution `world-postgres` gives no way to
 * get. That is the honest boundary of this fix, not an oversight.
 *
 * The keepalive below is what keeps the same outage from turning this fix into a
 * new hazard: a dropped connection releases our presence lock, and a pool
 * starting up in that window would read a live sibling as dead.
 *
 * Note the sweep restores AVAILABILITY, not attempts: `force_unlock_workers`
 * clears `locked_by`/`locked_at` and leaves `attempts` where it was, so a job
 * swept at 1 of 3 has two left. That is the right side to err on — a job whose
 * attempts were also reset could retry forever.
 */

import type { CloseableDb, ReservedDb } from "./postgres-db.ts";
import { createPostgresDb } from "./postgres-db.ts";

/**
 * The advisory lock every pool contends for, as the `(int4, int4)` pair.
 *
 * `0x41_41_49_57` is ASCII `AAIW`, so a `pg_locks` row is traceable to this code
 * rather than looking like a collision with somebody else's lock. The value is
 * arbitrary and only has to be STABLE — a `hashtext()` call would read better and
 * is documented as an internal function whose result may change between major
 * versions, which for a cross-process rendezvous is the one property it may not
 * have.
 *
 * Exported so a test or a verification script can contend for the SAME lock
 * without restating the number. That is not hypothetical tidiness: the first
 * verification hand-converted the hex to decimal, got it wrong by 2048, and so
 * held a different key — which made a sweep that ignored a live sibling look like
 * a broken gate and a broken gate look fine.
 *
 * @internal
 */
export const PRESENCE_LOCK_CLASS = 0x41_41_49_57;
/** @internal */
export const PRESENCE_LOCK_OBJECT = 1;

/**
 * How often presence is re-asserted.
 *
 * A dropped connection (a Postgres restart, a failover, a pooler timeout) ends
 * the session and with it our lock, and nothing tells us. Re-asserting bounds the
 * window in which a starting pool would read us as dead and sweep the jobs we are
 * running from "for the rest of this process's life" to this interval.
 */
const PRESENCE_REASSERT_MS = 15_000;

/** Why a sweep did nothing. */
export type SweepSkip =
  /** Another pool holds presence, so its locks are live and not ours to clear. */
  | "another-pool-is-live"
  /** Presence is ours and there was nothing locked. The healthy case. */
  | "no-orphaned-locks";

/**
 * The outcome, plus the presence this process must hold for its lifetime.
 *
 * @internal
 */
export type PoolPresence = {
  /** Worker ids whose locks were cleared. */
  swept: readonly string[];
  /** Set when nothing was swept. */
  skipped: SweepSkip | undefined;
  /** True while this process is the pool that holds presence. */
  held: boolean;
  /** Drop presence and close the connection behind it. Idempotent. */
  release: () => Promise<void>;
};

/** Injectable for tests, which have no Postgres. */
export type SweepDeps = {
  createDb?: (url: string) => CloseableDb;
  /** Defaults to `console.error`, matching this module's siblings. */
  log?: (message: string) => void;
};

/**
 * Take pool presence and, if this is the only live pool, clear orphaned locks.
 *
 * Call BEFORE the world's runner starts polling: the safety argument rests on
 * this pool holding no locks yet, and after `start()` it does.
 *
 * @internal
 */
export async function claimPoolPresenceAndSweep(
  url: string,
  deps: SweepDeps = {},
): Promise<PoolPresence> {
  const log = deps.log ?? ((message: string) => console.error(message));
  const db = (deps.createDb ?? ((at: string) => createPostgresDb({ url: at, max: 1 })))(url);
  let reserved: ReservedDb | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let released = false;

  /** Close everything this function opened. Safe to call from any exit path. */
  const teardown = async (unlock: boolean): Promise<void> => {
    if (timer !== undefined) clearInterval(timer);
    if (unlock && reserved) {
      await reserved
        .query("select pg_advisory_unlock($1, $2)", [PRESENCE_LOCK_CLASS, PRESENCE_LOCK_OBJECT])
        .catch(() => {
          // A connection that is already gone has already released the lock,
          // which is the whole reason presence is a SESSION lock.
        });
    }
    reserved?.release();
    await db.close();
  };

  try {
    // Reserved rather than pooled: a session lock taken on one pooled connection
    // and released on another leaves it held by an idle pool member forever, which
    // is exactly what `reserve()` exists for (see `postgres-db.ts`).
    reserved = await db.reserve();
    const [row] = await reserved.query<{ held: boolean }>(
      "select pg_try_advisory_lock($1, $2) as held",
      [PRESENCE_LOCK_CLASS, PRESENCE_LOCK_OBJECT],
    );
    if (row?.held !== true) {
      await teardown(false);
      log(
        "workflow lock sweep: another pool holds presence — skipping (its locks are live, " +
          "not orphans)",
      );
      return {
        swept: [],
        skipped: "another-pool-is-live",
        held: false,
        release: async () => {
          /* nothing was held */
        },
      };
    }

    const orphans = await findLockedWorkers(reserved);
    if (orphans.length > 0) {
      // graphile-worker's own function, which also unlocks the QUEUE rows for
      // these workers — a hand-rolled `update … jobs` would leave a locked queue
      // blocking every job in it, and the symptom would be identical to the wedge
      // being fixed. Verified present under this schema version; the SQL that
      // defines it is versioned with the migrations, so it is checked against a
      // real database rather than assumed (see `findLockedWorkers`).
      await reserved.query("select graphile_worker.force_unlock_workers($1::text[])", [orphans]);
      log(
        `workflow lock sweep: cleared locks held by ${orphans.length} dead worker(s) ` +
          `[${orphans.join(", ")}] — their steps are redeliverable again`,
      );
    }

    // Re-assert on an interval; unref'd so a page watching a run is never the
    // reason a host stays up.
    timer = setInterval(() => {
      void reserved
        ?.query("select pg_try_advisory_lock($1, $2)", [PRESENCE_LOCK_CLASS, PRESENCE_LOCK_OBJECT])
        .catch(() => {
          // Reported by the next startup that finds the lock free, not here: a
          // failed re-assert is a symptom of a link that is already down, and
          // logging it per interval would bury the outage's own message.
        });
    }, PRESENCE_REASSERT_MS);
    timer.unref?.();

    return {
      swept: orphans,
      skipped: orphans.length === 0 ? "no-orphaned-locks" : undefined,
      held: true,
      release: async () => {
        if (released) return;
        released = true;
        await teardown(true);
      },
    };
  } catch (err: unknown) {
    await teardown(false).catch(() => {
      // The original failure is the one worth reporting.
    });
    throw err;
  }
}

/**
 * Every worker id holding a job lock, read from the one PUBLIC relation.
 *
 * `graphile_worker.jobs` is a VIEW over `_private_jobs`, and it is the only
 * lock-bearing relation this schema version exposes without a leading underscore —
 * there is no `job_queues` view, which the first draft of this assumed and which
 * only a real database could report: with the fake all nine specs passed, and
 * against 0.16.6 the statement failed `relation "graphile_worker.job_queues" does
 * not exist`, so the sweep would have thrown on every boot and left the wedge in
 * place while logging a failure.
 *
 * Reading only `jobs` costs nothing here, because unlocking is
 * `force_unlock_workers`'s job and it updates the QUEUE rows for the same worker
 * ids as well. The one state that escapes is a queue locked by a worker holding no
 * locked job — which graphile-worker's own completion path does not produce, since
 * a queued job's row and its queue are locked and released together.
 */
async function findLockedWorkers(db: ReservedDb): Promise<string[]> {
  const rows = await db.query<{ locked_by: string }>(
    "select distinct locked_by from graphile_worker.jobs where locked_by is not null",
  );
  return rows.map((row) => row.locked_by).filter((id): id is string => typeof id === "string");
}
