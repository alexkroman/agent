// Copyright 2026 the AAI authors. MIT license.
/**
 * Does a stalled run really get rescheduled, on a real Postgres?
 *
 * Every claim here is a `not exists` correlated against two tables plus a grace
 * window compared in SQL, so a recorder could assert the statement text and
 * nothing about the answer — which is the `pg-cron.scenario.test.ts` lesson: a
 * predicate that stops matching is green.
 *
 * What it protects is the recovery that went missing with the DevKit's world.
 * The queue's retry budget was always backed by "the DevKit already recovers
 * from [abandonment] on any later boot, since its world re-enqueues active runs
 * on `start()`", and after the replay engine replaced that world an abandoned
 * message stalled its run permanently — the sweep's own warning said so and
 * nothing acted on it.
 *
 * ## Why this suite owns its DATABASE
 *
 * The pass is fleet-wide by design — it repairs every agent — so against a shared
 * database its answers include whatever a sibling left there.
 * `platform-workflow-journal.scenario.test.ts` seeds runs with a `created_at` of
 * `7` to test ordering, which is comfortably past the grace window.
 *
 * Scoping every assertion to this suite's own slug was the first answer and it
 * was not enough, because `findStalledRuns` has a `limit` as well as a filter: a
 * sibling's older rows can fill the answer and push this suite's own run out of
 * it, which surfaces as `expected [] to deeply equal [ 'wrun_stalled' ]` — a
 * predicate failure in a suite that did nothing wrong, about one full scenario
 * run in six. The slug filters below are kept because they document intent, but
 * what makes them true is `useThrowawayPlatformDb`.
 *
 * A private database is also what lets the second block call
 * `reconcileStalledRuns` at all. It WRITES, fleet-wide, so against the shared
 * database it would enqueue a message for every stalled run in it — seeding
 * `workflow-queue-store.scenario.test.ts`'s fleet-wide `claimDue` with foreign
 * rows and firing the NOTIFY its "a DELAYED message does not notify" case asserts
 * is absent.
 *
 * ```sh
 * AAI_TEST_PG_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
 *   pnpm --filter aai-server test:scenario
 * ```
 */

import { beforeAll, beforeEach, expect, test } from "vitest";
import { describeWithPg } from "./_pg-test-utils.ts";
import { RECONCILE_MAX_ATTEMPTS } from "./_reconcile-abandon.ts";
import { useThrowawayPlatformDb } from "./_workflow-queue-test-utils.ts";
import type { SqlExec } from "./secret-store.ts";
import {
  findStalledRuns,
  markReconciled,
  reconcileStalledRuns,
  STALL_GRACE_MS,
} from "./workflow-queue-reconcile.ts";

const SLUG = "reconcile-tenant";

describeWithPg("re-enqueueing a stalled run", () => {
  // A PRIVATE database — `findStalledRuns` is fleet-wide, including its
  // `order by created_at` and its `limit`, so a sibling suite's older rows can
  // push this suite's own run out of the answer. That is not hypothetical: it
  // failed here as `expected [] to deeply equal [ 'wrun_stalled' ]`, roughly one
  // full scenario run in six, in a suite that did nothing wrong. See
  // `useThrowawayPlatformDb`.
  const database = useThrowawayPlatformDb("reconcile_suite");
  const sql: SqlExec = (q, p) => database.sql()(q, p);

  /** Long enough ago to be past the grace window. */
  const stale = () => Date.now() - STALL_GRACE_MS - 60_000;

  beforeAll(async () => {
    await sql(
      `insert into aai_platform.agents (slug, credential_hashes, worker_hash, client_files, version)
       values ($1, '{}'::jsonb, '', '{}'::jsonb, 1) on conflict do nothing`,
      [SLUG],
    );
  });

  beforeEach(async () => {
    // Each case owns the whole table for this slug — the pass is fleet-wide by
    // design, so a leftover row from a sibling would be found by it.
    // By SLUG and by this suite's own ids: `workflow_queue`'s primary key is
    // global, so a bare `m1` collides with the sibling suite that also uses one.
    await sql("delete from aai_platform.workflow_queue where slug = $1", [SLUG]);
    // The journal's child tables reference `agents`, not `workflow_runs`, so
    // deleting the run does NOT cascade to them — a hook left behind would park
    // the next case's run under the same id and the failure would name the wrong
    // test.
    await sql("delete from aai_platform.workflow_hooks where slug = $1", [SLUG]);
    await sql("delete from aai_platform.workflow_sleeps where slug = $1", [SLUG]);
    await sql("delete from aai_platform.workflow_runs where slug = $1", [SLUG]);
  });

  const seedRun = (runId: string, status: string, createdAt = stale()) =>
    sql(
      `insert into aai_platform.workflow_runs (slug, run_id, workflow, status, created_at)
       values ($1, $2, 'digest', $3, $4)`,
      [SLUG, runId, status, createdAt],
    );

  const queued = () =>
    sql("select queue_name from aai_platform.workflow_queue where slug = $1", [SLUG]);

  /** Does the predicate name THIS run? A sibling's rows are its own business. */
  async function stalledIds(): Promise<string[]> {
    const found = await findStalledRuns(sql, { maxPerTick: 100 });
    return found.filter((run) => run.slug === SLUG).map((run) => run.runId);
  }

  test("a run out of re-walks is FAILED, and then the predicate stops finding it", async () => {
    // The unit tier owns the branch; what only a real database can show is the
    // consequence — that a failed run leaves `workflow_runs_stalled_idx`'s partial
    // predicate, so the pass is FINITE. Nothing else on the platform ever writes a
    // terminal status, so without this the run is re-enqueued every
    // `STALL_GRACE_MS` for as long as the table holds it.
    await sql(
      `insert into aai_platform.workflow_runs
         (slug, run_id, workflow, status, created_at, reconciles)
       values ($1, 'wrun_wedged', 'digest', 'running', $2, $3)`,
      [SLUG, stale(), RECONCILE_MAX_ATTEMPTS],
    );

    const pass = await reconcileStalledRuns(sql, { maxPerTick: 100 });
    expect(pass.abandoned).toBe(1);
    expect(pass.stalled).toBe(0);

    const [run] = await sql(
      "select status, error from aai_platform.workflow_runs where slug = $1 and run_id = $2",
      [SLUG, "wrun_wedged"],
    );
    expect(run?.status).toBe("failed");
    expect(String(run?.error)).toContain("stopped re-walking");
    // No sixth message, and it is no longer a candidate.
    expect(await queued()).toEqual([]);
    expect(await stalledIds()).toEqual([]);
  });

  test("`markReconciled` COUNTS the attempt, which is what the budget reads", async () => {
    // The stamp is the one write per pass that names exactly the runs a repair was
    // issued for, so the count rides it. Two passes, two strikes — and a run under
    // the budget is repaired rather than failed, which is the other half.
    await seedRun("wrun_counted", "running");
    const before = await findStalledRuns(sql, { maxPerTick: 100 });
    expect(before.find((run) => run.runId === "wrun_counted")?.reconciles).toBe(0);

    await markReconciled(sql, [{ slug: SLUG, runId: "wrun_counted" }]);
    await markReconciled(sql, [{ slug: SLUG, runId: "wrun_counted" }]);
    const [row] = await sql(
      "select reconciles from aai_platform.workflow_runs where slug = $1 and run_id = $2",
      [SLUG, "wrun_counted"],
    );
    expect(Number(row?.reconciles)).toBe(2);
  });

  test("an unfinished run with no message is re-enqueued on its own topic", async () => {
    // The reported failure, end to end: `abandoned 1 message(s) after the retry
    // budget — those runs are stalled until something else boots their agent`,
    // and nothing was going to boot their agent.
    await seedRun("wrun_stalled", "running");
    expect(await stalledIds()).toEqual(["wrun_stalled"]);
  });

  test("a PENDING run counts too, which is a start whose enqueue failed", async () => {
    // `workflow-platform-dispatch.ts` logs that case and cannot do more: the run
    // has a journal row and no message, and never left `pending`.
    await seedRun("wrun_never_started", "pending");
    expect(await stalledIds()).toEqual(["wrun_never_started"]);
  });

  test("leaves a run that ALREADY has a message alone", async () => {
    // The `not exists` is the whole guard: without it every healthy scheduled
    // run is re-enqueued on every idle tick.
    await seedRun("wrun_scheduled", "running");
    await sql(
      `insert into aai_platform.workflow_queue
         (id, slug, queue_name, payload, available_at)
       values ('reconcile-suite-m1', $1, '__wkf_workflow_wrun_scheduled', '{}'::jsonb,
               now() + interval '1 hour')`,
      [SLUG],
    );
    expect(await stalledIds()).toEqual([]);
    // And the message it started with is untouched.
    expect(await queued()).toHaveLength(1);
  });

  test("leaves a run inside the GRACE window alone, being walked right now", async () => {
    // A run that went `running` moments ago is held by a guest that has not
    // journaled yet. Re-enqueueing it would double-deliver constantly, and a
    // second walk burns an attempt off every step's ceiling.
    await seedRun("wrun_fresh", "running", Date.now());
    expect(await stalledIds()).toEqual([]);
  });

  test.each(["completed", "failed", "cancelled"])(
    "leaves a %s run alone, there being nothing to walk",
    async (status) => {
      await seedRun(`wrun_${status}`, status);
      expect(await stalledIds()).toEqual([]);
    },
  );

  test("bounds a pass, so a fleet-wide outage is not a boot storm", async () => {
    for (let i = 0; i < 5; i++) await seedRun(`wrun_many_${i}`, "running");
    // The BOUND is the claim, not which runs it picked: a sibling suite's rows
    // are in the same fleet-wide scan and may take either slot.
    expect(await findStalledRuns(sql, { maxPerTick: 2 })).toHaveLength(2);
  });

  test("reports each run with its OWN slug, which the enqueue brokers on", async () => {
    // The scan is fleet-wide on purpose — it repairs every agent — so the slug
    // has to travel with the run. A message written under the wrong one brokers
    // the wrong sandbox.
    await seedRun("wrun_scoped", "running");
    const found = await findStalledRuns(sql, { maxPerTick: 100 });
    // `objectContaining`, because the claim is that the SLUG travels with the
    // run — not what else the row carries. An exact match here broke on the day
    // the predicate grew `reconciles`, and only against a real database: the
    // strike count is what the abandonment budget reads, and the case above owns
    // its default.
    expect(found).toContainEqual(expect.objectContaining({ slug: SLUG, runId: "wrun_scoped" }));
  });

  const seedHook = (
    runId: string,
    key: string,
    token: string,
    flags: { delivered?: boolean; closed?: boolean } = {},
  ) =>
    sql(
      `insert into aai_platform.workflow_hooks (slug, run_id, key, token, delivered, closed)
       values ($1, $2, $3, $4, $5, $6)`,
      [SLUG, runId, key, token, flags.delivered ?? false, flags.closed ?? false],
    );

  const seedSleep = (runId: string, key: string, wakeAt: number, kind = "hookTimeout") =>
    sql(
      `insert into aai_platform.workflow_sleeps (slug, run_id, key, wake_at, kind)
       values ($1, $2, $3, $4, $5)`,
      [SLUG, runId, key, wakeAt, kind],
    );

  test("leaves a run PARKED on an UNTIMED hook alone — the approval workflow", async () => {
    // `await ctx.waitFor(token)` with no `timeoutMs` is not a stalled run, it is
    // the steady state of the human-approval workflow the SDK documents:
    // `workflow-replay.ts` suspends with `wakeAt: undefined` and
    // `workflow-engine.ts` dispatches only when `wakeAt !== undefined` ("a HOOK
    // does not [schedule its own delivery] … dispatching anyway would poll a run
    // that may be parked for a week"). So `running` + no queue row is EXACTLY
    // what such a run looks like, for as long as nobody approves it.
    //
    // Without this arm the pass re-enqueued it, the platform booted a sandbox,
    // the guest re-walked and re-suspended, `ack` DELETED the row, and the next
    // idle tick did it again — permanently, per parked run, fleet-wide.
    await seedRun("wrun_awaiting_approval", "running");
    await seedHook("wrun_awaiting_approval", "hook!0", "tok_approval");
    expect(await stalledIds()).toEqual([]);
  });

  test("a DELIVERED hook parks nothing — the answer already arrived", async () => {
    // `claimHook` is idempotent and the payload is read on the next walk, so a
    // delivered hook with no message means the re-delivery `signal` was supposed
    // to schedule never landed. That IS a stalled run.
    await seedRun("wrun_answered", "running");
    await seedHook("wrun_answered", "hook!0", "tok_answered", { delivered: true });
    expect(await stalledIds()).toEqual(["wrun_answered"]);
  });

  test("a CLOSED hook parks nothing — the window is over", async () => {
    await seedRun("wrun_closed", "running");
    await seedHook("wrun_closed", "hook!0", "tok_closed", { closed: true });
    expect(await stalledIds()).toEqual(["wrun_closed"]);
  });

  test("a hook whose DEADLINE has elapsed is stalled again", async () => {
    // A TIMED `waitFor` journals its deadline as a `hookTimeout` sleep and
    // suspends with a `wakeAt`, so the engine dispatches and the queue row is
    // what excludes it. If that message is lost, the deadline passes with an open
    // hook and nothing scheduled — which the open-hook arm would otherwise hide
    // forever. So the park only holds while the run is still WAITING for
    // something that has not come due.
    await seedRun("wrun_deadline_passed", "running");
    await seedHook("wrun_deadline_passed", "hook!0", "tok_late");
    await seedSleep("wrun_deadline_passed", "hookTimeout!0", stale());
    expect(await stalledIds()).toEqual(["wrun_deadline_passed"]);
  });

  test("a hook whose deadline is still in the future stays parked", async () => {
    await seedRun("wrun_deadline_pending", "running");
    await seedHook("wrun_deadline_pending", "hook!0", "tok_pending");
    await seedSleep("wrun_deadline_pending", "hookTimeout!0", Date.now() + 60 * 60_000);
    expect(await stalledIds()).toEqual([]);
  });

  test("a run reconciled moments ago is NOT reconciled again", async () => {
    // The grace window used to gate FIRST eligibility only: `created_at` is fixed
    // at creation, so past ten minutes a run was eligible on every pass, with no
    // throttle and no backoff. A guest that cannot be reached burns
    // `QUEUE_MAX_ATTEMPTS` in ~380s, gets dropped, and was back within one tick —
    // defeating the budget whose whole justification is that every attempt boots
    // a sandbox.
    await seedRun("wrun_throttled", "running");
    await sql(
      "update aai_platform.workflow_runs set reconciled_at = $3 where slug = $1 and run_id = $2",
      [SLUG, "wrun_throttled", Date.now()],
    );
    expect(await stalledIds()).toEqual([]);
  });

  test("a run reconciled longer ago than the window is eligible again", async () => {
    // The throttle is a window, not a one-shot: a run nothing has repaired must
    // keep being tried, just not at 1 Hz per replica.
    await seedRun("wrun_retryable", "running");
    await sql(
      "update aai_platform.workflow_runs set reconciled_at = $3 where slug = $1 and run_id = $2",
      [SLUG, "wrun_retryable", stale()],
    );
    expect(await stalledIds()).toEqual(["wrun_retryable"]);
  });

  test("markReconciled stamps exactly the runs a pass took, and nothing else", async () => {
    // The write half of the throttle. `reconcileStalledRuns` is what calls it,
    // and this suite deliberately never calls THAT — see the module doc: a real
    // queue row for one of our runs is claimed by the sibling suite's fleet-wide
    // `claimDue` and breaks a `toEqual([ids])` over there.
    // Distinct `created_at`s, so the `order by` makes the pair's order a FACT
    // rather than something to sort back into shape afterwards.
    await seedRun("wrun_stamped", "running", stale() - 1000);
    await seedRun("wrun_untouched", "running", stale());
    expect(await stalledIds()).toEqual(["wrun_stamped", "wrun_untouched"]);

    await markReconciled(sql, [{ slug: SLUG, runId: "wrun_stamped" }]);

    expect(await stalledIds()).toEqual(["wrun_untouched"]);
  });

  test("markReconciled on an empty pass issues no statement at all", async () => {
    // The guard is worth a case because the statement it skips is an `unnest` of
    // two empty arrays, which is a legal no-op — so the check is about the round
    // trip, on a connection the claim's own doc calls briefly reserved.
    await expect(markReconciled(sql, [])).resolves.toBeUndefined();
  });
});

/**
 * One un-enqueueable run must not cost the rest of the pass.
 *
 * Its own database again (see the file doc), built by `ensurePlatformTables` from
 * the migrations' own `create table` text — which is what makes the FOREIGN KEY
 * here the shipped one rather than a shape this test invented.
 *
 * ## The state under test cannot be seeded, only RACED
 *
 * `workflow_runs.slug` and `workflow_queue.slug` both reference `agents` with
 * `on delete cascade`, so a run whose agent is gone does not exist — verified
 * against the live catalog, and it is why there is no orphan row to seed. The
 * production failure is a TOCTOU: the predicate reads `(slug, run_id)`, then the
 * loop's inserts run as separate autocommit statements on a reserved (NOT
 * transacted) connection, and a delete landing in between leaves the loop
 * holding a slug the FK no longer accepts. The `SqlExec` wrapper below executes
 * exactly that interleaving, so the error is Postgres's real `23503`.
 */
describeWithPg("a reconcile pass survives one un-enqueueable run", () => {
  const HEALTHY = "reconcile-live-tenant";
  const DOOMED = "reconcile-doomed-tenant";

  const database = useThrowawayPlatformDb("reconcile_fk");
  const sql: SqlExec = (q, p) => database.sql()(q, p);

  beforeAll(async () => {
    for (const slug of [HEALTHY, DOOMED]) {
      await sql(
        `insert into aai_platform.agents (slug, credential_hashes, worker_hash, client_files, version)
         values ($1, '{}'::jsonb, '', '{}'::jsonb, 1)`,
        [slug],
      );
    }
  });

  test("a run whose agent vanished mid-pass is skipped, and the others still land", async () => {
    // The DOOMED run is OLDER, so `order by created_at` puts it FIRST. That is
    // the half that makes this a regression test rather than a coincidence:
    // before the fix the throw happened on the first iteration, so the healthy
    // run was never enqueued at all and NOTHING was stamped.
    await sql(
      `insert into aai_platform.workflow_runs (slug, run_id, workflow, status, created_at)
       values ($1, 'wrun_doomed', 'digest', 'running', $2),
              ($3, 'wrun_healthy', 'digest', 'running', $4)`,
      [
        DOOMED,
        Date.now() - STALL_GRACE_MS - 120_000,
        HEALTHY,
        Date.now() - STALL_GRACE_MS - 60_000,
      ],
    );

    let statements = 0;
    /** The real connection, with the delete spliced in after the predicate. */
    const raced: SqlExec = async (query, params) => {
      statements += 1;
      const isPredicate = statements === 1;
      const rows = await sql(query, params);
      // The race, deliberately: the predicate has answered and named both runs,
      // and the agent goes away before the first insert reaches the FK.
      if (isPredicate) await sql("delete from aai_platform.agents where slug = $1", [DOOMED]);
      return rows;
    };

    const pass = await reconcileStalledRuns(raced, { maxPerTick: 10 });

    // One repaired, one skipped — and `skipped: 1` can only be reached through a
    // real `23503`, so this is also what proves the FK is present.
    expect(pass).toEqual({ stalled: 1, skipped: 1, abandoned: 0 });
    // The assertion that matters: the OTHER tenant's work still happened.
    const queued = await sql("select slug, queue_name from aai_platform.workflow_queue");
    expect(queued.map((row) => String(row.queue_name))).toEqual(["__wkf_workflow_wrun_healthy"]);
    expect(queued.map((row) => String(row.slug))).toEqual([HEALTHY]);
    // And it was STAMPED, which is the throttle the pass-wide throw used to lose
    // for every run in the batch — the boot storm, not the bad status code.
    const stamped = await sql(
      "select reconciled_at from aai_platform.workflow_runs where slug = $1",
      [HEALTHY],
    );
    expect(stamped[0]?.reconciled_at).not.toBeNull();
    // The doomed run went with its agent, so there is nothing left to tombstone.
    const left = await sql(
      "select count(*)::int as n from aai_platform.workflow_runs where slug = $1",
      [DOOMED],
    );
    expect(left[0]?.n).toBe(0);
  });
});
