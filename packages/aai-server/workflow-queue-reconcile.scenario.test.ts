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
 * ## Why every assertion is scoped to THIS slug
 *
 * The pass is fleet-wide by design — it repairs every agent — so its return
 * counts include whatever a sibling suite left in the shared scenario database.
 * `platform-workflow-journal.scenario.test.ts` seeds runs with a `created_at` of
 * `7` to test ordering, which is comfortably past the grace window, so asserting
 * a global `{ stalled: 1 }` here fails the moment the two files run together.
 *
 * Asserting on rows for this suite's own slug is the fix, and the `afterEach`
 * that removes what the pass ENQUEUED is the other half: without it a message
 * written for a foreign run is claimed by `workflow-queue-store.scenario.test.ts`
 * and breaks an `toEqual([ids])` over there. That file's own doc warns about
 * exactly this shape — "two files over one database cannot run concurrently" —
 * and the reason this suite is nonetheless separate is that it calls neither
 * `claimDue` nor the NOTIFY channel, which is the split that doc allows.
 *
 * ```sh
 * AAI_TEST_PG_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
 *   pnpm --filter aai-server test:scenario
 * ```
 */

import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";
import type { SqlExec } from "./secret-store.ts";
import { ensurePlatformTables } from "./test-utils.ts";
import { findStalledRuns, STALL_GRACE_MS } from "./workflow-queue-reconcile.ts";

const SLUG = "reconcile-tenant";

describeWithPg("re-enqueueing a stalled run", () => {
  let db: ReturnType<typeof createPostgresDb>;
  let sql: SqlExec;

  /** Long enough ago to be past the grace window. */
  const stale = () => Date.now() - STALL_GRACE_MS - 60_000;

  beforeAll(async () => {
    db = createPostgresDb({ url: pgUrl(), max: 4 });
    sql = (q, p) => db.query(q, p);
    await ensurePlatformTables(sql);
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
    await sql("delete from aai_platform.workflow_runs where slug = $1", [SLUG]);
  });

  afterAll(async () => {
    await sql("delete from aai_platform.agents where slug = $1", [SLUG]);
    await db.close();
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
    expect(found).toContainEqual({ slug: SLUG, runId: "wrun_scoped" });
  });
});
