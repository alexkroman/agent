// Copyright 2026 the AAI authors. MIT license.
/**
 * The orphaned-queue-lock sweep against a REAL Postgres, over the REAL
 * graphile-worker schema.
 *
 * `aai/host/workflow-lock-sweep.test.ts` drives the sweep against a fake
 * `CloseableDb` and covers its POLICY well — who may sweep, what is unlocked,
 * what is held afterwards. It is candid that a fake cannot check "that
 * `graphile_worker.force_unlock_workers` exists and does what its name says",
 * and pointed at the module doc for the verification. What is recorded there is
 * a past hard-kill MEASUREMENT, not a thing that runs. This file is the thing
 * that runs.
 *
 * Four claims live here, and a fake can only restate any of them:
 *
 * - **`force_unlock_workers` exists.** It is graphile-worker's own function,
 *   its SQL is versioned with the migrations, and the fake answers every
 *   statement by pattern — so a renamed function, a changed signature, or a
 *   schema version that never shipped it are all green there and fatal on a
 *   real boot. That is not hypothetical: the first draft of this module also
 *   read `graphile_worker.job_queues`, which 0.16.6 does not expose, and all
 *   nine fake-driven specs passed while every real boot would have thrown.
 * - **It does what its name says, and NOTHING more.** It clears
 *   `locked_by`/`locked_at` on the job AND on the QUEUE row of the same worker,
 *   and leaves `attempts` alone — "a job swept at 1 of 3 has two left", because
 *   a job whose attempts were also reset could retry forever.
 * - **A swept job becomes VISIBLE again.** `is_available` is what
 *   graphile-worker's own `get_job` selects on, so it — not `locked_by` — is
 *   the column that decides whether a parked run ever resumes. It is a stored
 *   generated column with NO time term, which is what makes this sweep "the
 *   ONLY recovery, not an accelerator of one"; that too is asserted here rather
 *   than believed from reading a migration.
 * - **The presence advisory lock really EXCLUDES, and really dies with its
 *   connection.** `pg_try_advisory_lock` refusing a second SESSION is what makes
 *   sweeping safe beside a live sibling, and its release on DISCONNECT — never
 *   on an explicit unlock — is the entire reason a SIGKILLed predecessor is
 *   distinguishable from a live one. Both contenders here are genuinely
 *   separate connections (`reserve()`, and a pool of its own): a pooled handle
 *   that hands both to one backend proves nothing, because a session lock is
 *   re-entrant within its own session.
 *
 * `PRESENCE_LOCK_CLASS`/`PRESENCE_LOCK_OBJECT` are IMPORTED, never restated —
 * the first verification hand-converted the hex to decimal, got it wrong by
 * 2048, and so contended for a different key, which made a sweep that ignored a
 * live sibling look like a broken gate and a broken gate look fine.
 *
 * ## Where the schema comes from
 *
 * From the Workflow DevKit's own world migration, reached through the exported
 * boot path (`startWorkflowWorldIfDeclared`), which bootstraps graphile-worker's
 * schema with graphile-worker's own migrations. Standing `force_unlock_workers`
 * up by hand would assert nothing at all: the whole finding is that the REAL
 * function is unverified.
 *
 * Two things about that boot are worth knowing before reading `createWorld`.
 * The world's RUNNER is deliberately never subscribed (`WORKFLOW_TARGET_WORLD`
 * names the local world, which has no `start`) — a live pool would claim the
 * very jobs this suite plants as orphans, and a queue with no worker running is
 * by definition the state the sweep exists for. And the boot REPORTS a failure
 * it did not have: `@workflow/world-postgres`'s `setupDatabase` ends its success
 * path with `process.exit(0)`, which `migratePostgresWorld`'s stand-in turns
 * into a throw INSIDE `setupDatabase`'s own `try`, so its `catch` logs "Failed
 * to setup database" and calls `process.exit(1)`. The schema is fully migrated
 * either way — that is why this suite can use it — but the boot path aborts
 * before it reaches the sweep, which is why the sweep is called directly here.
 *
 * ## Isolation
 *
 * The scratch DATABASE is created here and dropped in `afterAll`; nothing
 * touches the database `AAI_TEST_PG_URL` names beyond `create`/`drop database`.
 * That is not tidiness. The sweep's schema is `graphile_worker`, unqualified and
 * unconfigurable, and its presence lock is the real one — so running in a shared
 * database would fight any other suite, and any other developer, using either.
 * Advisory locks are scoped per database, so a lock taken here is invisible
 * everywhere else.
 */

import { type CloseableDb, createPostgresDb, type ReservedDb } from "@alexkroman1/aai-runtime";
import {
  claimPoolPresenceAndSweep,
  type PoolPresence,
  PRESENCE_LOCK_CLASS,
  PRESENCE_LOCK_OBJECT,
  startWorkflowWorldIfDeclared,
} from "@alexkroman1/aai-runtime/internal";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";

/** The task a planted job names. Never executed — no runner is ever subscribed. */
const PROBE_TASK = "aai-lock-sweep-probe";
/** The queue a planted job sits in, so the QUEUE row's lock is covered too. */
const PROBE_QUEUE = "aai-lock-sweep-queue";
/** What a job's attempts must survive the sweep as: 1 of 3, with two left. */
const PLANTED_ATTEMPTS = 1;
/** Low enough that an unlocked job is available again, unlike a failed one. */
const PLANTED_MAX_ATTEMPTS = 3;

/** One job row, as the sweep's premise cares about it. */
type JobRow = {
  locked_by: string | null;
  locked_at: Date | null;
  attempts: number;
  max_attempts: number;
  is_available: boolean;
};

describeWithPg("workflow lock sweep over a real graphile-worker schema", () => {
  /** Connected to the server's own database: it only creates and drops. */
  let admin: CloseableDb;
  /** Connected to the scratch database: the queue under test. */
  let db: CloseableDb;
  /** The scratch database's URL, which is what the sweep is pointed at. */
  let worldUrl: string;
  let database: string | undefined;
  /** Presence taken by a test, released in `afterEach` whatever the outcome. */
  let presence: PoolPresence | undefined;

  /** A database name no concurrent run, and no other suite, can collide with. */
  function scratchName(): string {
    return `aai_lock_sweep_${Math.random().toString(36).slice(2, 10)}`;
  }

  /** The connection URL for one database on the configured server. */
  function urlFor(name: string): string {
    const at = new URL(pgUrl());
    at.pathname = `/${name}`;
    return at.toString();
  }

  /**
   * Create the scratch database and install the DevKit's world in it.
   *
   * `WORKFLOW_POSTGRES_URL` is deliberately absent: the migration falls back to
   * `DATABASE_URL`, and the sweep does not, so this boot migrates without
   * sweeping — which keeps the boot path's own (currently unreachable) sweep out
   * of every test's setup, whether or not the exit-code defect above is fixed.
   */
  async function createWorld(): Promise<string> {
    const name = scratchName();
    await admin.query(`create database "${name}"`);
    database = name;
    vi.stubEnv("WORKFLOW_POSTGRES_URL", undefined);
    vi.stubEnv("DATABASE_URL", urlFor(name));
    // The local world has no `start`, so nothing subscribes to the queue.
    vi.stubEnv("WORKFLOW_TARGET_WORLD", "local");
    // Its own logs are the DevKit's, and they are loud; the boot reports a
    // failure it did not have (see the module doc), so silencing is also what
    // keeps that from reading as this suite's own failure.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await startWorkflowWorldIfDeclared(true, "postgres");
    } finally {
      spy.mockRestore();
    }
    return name;
  }

  /**
   * Plant one job held by a worker that is gone, in a queue it also locked.
   *
   * `add_job` is graphile-worker's own entry point, so the job row, its queue
   * row and its task row are shaped exactly as a real enqueue shapes them. The
   * `update` is what a claim leaves behind — and what a hard kill then strands,
   * since nothing ever clears it.
   */
  async function plantOrphan(workerId: string): Promise<void> {
    await db.query("select graphile_worker.add_job($1, null, $2)", [PROBE_TASK, PROBE_QUEUE]);
    await db.query(
      `update graphile_worker._private_jobs
          set locked_by = $1, locked_at = now(), attempts = $2, max_attempts = $3`,
      [workerId, PLANTED_ATTEMPTS, PLANTED_MAX_ATTEMPTS],
    );
    await db.query(
      "update graphile_worker._private_job_queues set locked_by = $1, locked_at = now()",
      [workerId],
    );
  }

  /**
   * The planted job.
   *
   * Read from `_private_jobs` rather than the public `jobs` view the sweep
   * itself reads, because `is_available` is not ON that view — it is the
   * generated column the runner selects by, which is what makes it the
   * interesting one.
   */
  async function jobRow(): Promise<JobRow> {
    const rows = await db.query<JobRow>(
      `select locked_by, locked_at, attempts, max_attempts, is_available
         from graphile_worker._private_jobs`,
    );
    const row = rows[0];
    // Thrown rather than asserted: a missing row means the SETUP did not do what
    // it claims, which is not the thing under test — and an `expect` in a helper
    // is what biome's `noMisplacedAssertion` exists to reject.
    if (!row) throw new Error("no planted job — plantOrphan did not do what it claims");
    return row;
  }

  /** The queue row's lock, which `force_unlock_workers` clears in the same call. */
  async function queueLockedBy(): Promise<string | null> {
    const rows = await db.query<{ locked_by: string | null }>(
      "select locked_by from graphile_worker._private_job_queues",
    );
    return rows[0]?.locked_by ?? null;
  }

  /**
   * Take the REAL presence lock on a connection of its own, standing in for
   * another pool.
   *
   * A pool of its own, and `reserve()` within it, because these are SESSION
   * locks: a pooled handle that happened to give both contenders the same
   * backend would report the lock as free, a session lock being re-entrant
   * within its own session.
   *
   * The reservation is handed back to the pool as soon as the lock is taken,
   * which does NOT release the lock — that is the hazard `postgres-db.ts`
   * documents, a lock "left held by an idle pool member forever", and here it is
   * the useful half: only closing the pool ends the session, which is the event
   * under test. It also has to be done, since `close()` waits for a reservation
   * that is still outstanding.
   */
  async function holdPresenceElsewhere(): Promise<{ pool: CloseableDb; held: boolean }> {
    const pool = createPostgresDb({ url: worldUrl, max: 1 });
    const reserved: ReservedDb = await pool.reserve();
    try {
      const [row] = await reserved.query<{ held: boolean }>(
        "select pg_try_advisory_lock($1, $2) as held",
        [PRESENCE_LOCK_CLASS, PRESENCE_LOCK_OBJECT],
      );
      return { pool, held: row?.held === true };
    } finally {
      reserved.release();
    }
  }

  /** Can a fresh session take presence, i.e. does nobody hold it? */
  async function presenceIsFree(): Promise<boolean> {
    const probe = await holdPresenceElsewhere();
    await probe.pool.close();
    return probe.held;
  }

  beforeAll(async () => {
    admin = createPostgresDb({ url: pgUrl(), max: 2 });
    worldUrl = urlFor(await createWorld());
    db = createPostgresDb({ url: worldUrl, max: 2 });
  });

  beforeEach(async () => {
    // A leaked lock from an earlier test would silently turn the next sweep into
    // a skip, so it is checked rather than assumed.
    if (!(await presenceIsFree())) {
      throw new Error("presence was already held before this test — earlier state leaked");
    }
  });

  afterEach(async () => {
    // Presence outliving its test would make every later sweep decline, which
    // reads as a broken gate rather than as leaked state.
    await presence?.release();
    presence = undefined;
    await db.query("delete from graphile_worker._private_jobs");
    await db.query("delete from graphile_worker._private_job_queues");
  });

  afterAll(async () => {
    await db.close();
    // `force`: a sweep that is left holding presence keeps a connection open by
    // design, and a `drop database` behind a live backend fails.
    if (database) await admin.query(`drop database if exists "${database}" with (force)`);
    await admin.close();
  });

  test("it clears a lock no live pool owns, and leaves attempts alone", async () => {
    await plantOrphan("worker-dead-1");
    const before = await jobRow();
    // The premise, asserted rather than assumed: a locked job is invisible to
    // the runner's own selection criterion, and no amount of waiting changes it.
    expect(before.is_available).toBe(false);

    presence = await claimPoolPresenceAndSweep(worldUrl, { log: () => undefined });

    expect(presence.swept).toEqual(["worker-dead-1"]);
    expect(presence.skipped).toBeUndefined();
    expect(presence.held).toBe(true);

    const after = await jobRow();
    expect(after.locked_by).toBeNull();
    expect(after.locked_at).toBeNull();
    // The asymmetry that matters: availability is restored, attempts are not
    // reset. A job swept at 1 of 3 has two left.
    expect(after.attempts).toBe(PLANTED_ATTEMPTS);
    expect(after.max_attempts).toBe(PLANTED_MAX_ATTEMPTS);
    // The property the whole sweep exists to restore.
    expect(after.is_available).toBe(true);
    // The QUEUE row too, in the same call. A hand-rolled `update … jobs` would
    // leave a locked queue blocking every job in it — a symptom identical to the
    // wedge being fixed.
    expect(await queueLockedBy()).toBeNull();
  });

  test("it reports what it cleared, naming the worker", async () => {
    // The log line is the only trace a sweep leaves on a real boot, so "did
    // recovery happen" has to be answerable from it.
    const lines: string[] = [];
    await plantOrphan("worker-dead-2");

    presence = await claimPoolPresenceAndSweep(worldUrl, { log: (line) => lines.push(line) });

    expect(lines).toContainEqual(expect.stringContaining("worker-dead-2"));
    expect(lines).toContainEqual(expect.stringContaining("1 dead worker"));
  });

  test("a live sibling pool means it sweeps NOTHING", async () => {
    // The case that makes the advisory lock load-bearing rather than decoration:
    // unlocking a job a live worker is executing runs that step twice, which is
    // worse than the wedge. `aai dev` against a production DATABASE_URL is the
    // configuration that really reaches this.
    const sibling = await holdPresenceElsewhere();
    try {
      expect(sibling.held).toBe(true);
      await plantOrphan("worker-live-1");

      const result = await claimPoolPresenceAndSweep(worldUrl, { log: () => undefined });

      expect(result.skipped).toBe("another-pool-is-live");
      expect(result.swept).toEqual([]);
      expect(result.held).toBe(false);
      const after = await jobRow();
      expect(after.locked_by).toBe("worker-live-1");
      expect(after.is_available).toBe(false);
      expect(await queueLockedBy()).toBe("worker-live-1");
    } finally {
      await sibling.pool.close();
    }
  });

  test("a predecessor that DIED has already given presence up", async () => {
    // The case the whole design rests on. A SIGKILLed pool runs no shutdown
    // path, so nothing calls `pg_advisory_unlock` — the session ENDING is the
    // release, and that is the only thing that tells a dead predecessor from a
    // live sibling. Nothing here unlocks: the connection simply goes away.
    const predecessor = await holdPresenceElsewhere();
    expect(predecessor.held).toBe(true);
    await plantOrphan("worker-dead-3");

    const declined = await claimPoolPresenceAndSweep(worldUrl, { log: () => undefined });
    expect(declined.skipped).toBe("another-pool-is-live");
    expect((await jobRow()).locked_by).toBe("worker-dead-3");

    await predecessor.pool.close();

    presence = await claimPoolPresenceAndSweep(worldUrl, { log: () => undefined });
    expect(presence.swept).toEqual(["worker-dead-3"]);
    const after = await jobRow();
    expect(after.locked_by).toBeNull();
    expect(after.is_available).toBe(true);
  });

  test("presence is HELD for the life of the pool, and released by `release`", async () => {
    // What the next pool to start reads. Held, it must refuse a second session;
    // released, the successor must be able to take it — the same handle both
    // ways, so a release that only closed the pool would still pass the first
    // half and fail the second.
    presence = await claimPoolPresenceAndSweep(worldUrl, { log: () => undefined });
    expect(presence.held).toBe(true);
    expect(await presenceIsFree()).toBe(false);

    await presence.release();
    presence = undefined;

    expect(await presenceIsFree()).toBe(true);
  });

  test("`is_available` carries no time term, so nothing else ever reclaims a job", async () => {
    // The claim that makes this sweep "the ONLY recovery, not an accelerator of
    // one". If a future graphile-worker adds a `locked_at < now() - interval …`
    // term, the queue starts reclaiming on its own and this module's urgency
    // changes — which should fail here rather than be discovered by reading
    // somebody else's migrations.
    const [row] = await db.query<{ expression: string | null }>(
      `select generation_expression as expression
         from information_schema.columns
        where table_schema = 'graphile_worker'
          and table_name = '_private_jobs'
          and column_name = 'is_available'`,
    );
    const expression = row?.expression ?? "";
    expect(expression).not.toBe("");
    expect(expression).toContain("locked_at");
    expect(expression).toContain("attempts");
    expect(expression.toLowerCase()).not.toContain("now()");
    expect(expression.toLowerCase()).not.toContain("current_timestamp");
  });
});
