// Copyright 2026 the AAI authors. MIT license.
/**
 * The delivery claim's EQUIVALENCE, against a real Postgres and its planner.
 *
 * `claimDue` was rewritten for cost — a group-minimum anti-join in place of
 * `distinct on`, the `locked_at` OR split into a `union all`, and the outer limit
 * pushed into each arm (that function's own doc carries the measurements and the
 * argument that each step is provably free). Every one of those is a claim about
 * what the PLANNER does with a statement, so no fake can check it: a recorder
 * asserts the SQL we wrote, which is the thing under test. What is checkable is
 * that the rewrite selects the same rows, and only a server can say so.
 *
 * ## The baseline is FROZEN on purpose
 *
 * {@link LEGACY_CANDIDATES} is the pre-rewrite selection, kept here verbatim
 * rather than derived from anything. That makes it a SPECIFICATION of what the
 * claim takes — one per run for orchestration, a bounded fan-out for steps,
 * oldest-due first across the whole due set — expressed in the shape that was in
 * production before the rewrite and read by the same planner. It is deliberately
 * not updated when `claimDue` changes again: the next rewrite has to answer to
 * the same selection, and a baseline regenerated from the subject asserts
 * nothing. If a future change means to CHANGE what is claimed, the change is to
 * this file and to the doc above the function, in the same commit.
 *
 * ## Its own database, which is what makes a second queue suite possible
 *
 * `workflow-queue-store.scenario.test.ts`'s doc records that splitting a claim
 * suite off it was tried and reverted: `claimDue` takes due messages for ANY
 * slug, so per-suite slugs isolate the rows a test writes and nothing about the
 * fleet-wide predicate that reads them, and ~20 cases failed with both suites
 * present. `useThrowawayPlatformDb` is what closed that — this suite's fixture
 * creates and migrates a database of its own — so the isolation here is the
 * DATABASE and not a naming convention. Do not "simplify" it back onto
 * `pgUrl()`.
 *
 * ## Ties on `available_at` are the one divergence, and it is pinned below
 *
 * The old `order by slug, run_id, available_at` carried no `id` tiebreak, so
 * which of two same-run messages due in the same instant won was PLAN-dependent;
 * the anti-join always takes the lower id. So the differential generates a unique
 * due time per row — comparing against a plan-dependent answer measures the plan
 * — and `a tie inside one run claims the lower id` states the new behaviour
 * directly, which is what a reader of the doc's "one behaviour difference" needs.
 */

import { expect, test } from "vitest";
import { describeWithPg } from "./_pg-test-utils.ts";
import { byCodeUnit, useQueueFixture } from "./_workflow-queue-test-utils.ts";
import type { SqlExec } from "./secret-store.ts";
import {
  claimDue,
  QUEUE_CLAIM_STALE_MS,
  WORKFLOW_QUEUE_STEPS_PER_RUN,
} from "./workflow-queue-claim.ts";

/**
 * The claim's candidate selection AS IT WAS before the anti-join rewrite,
 * read-only.
 *
 * Parameterised exactly like {@link claimDue} — `$1` limit, `$2` stale
 * milliseconds as text, `$3` steps per run — so the two statements are handed
 * the same numbers by the same driver and any difference is the SQL.
 */
const LEGACY_CANDIDATES = `with stale as (
       select now() - $2::bigint * interval '1 millisecond' as before
     ),
     orchestration_due as (
       select distinct on (q.slug, q.run_id) q.id, q.available_at
       from aai_platform.workflow_queue q
       where q.available_at <= now()
         and q.kind = 'workflow'
         and q.run_id is not null
         and (q.locked_at is null or q.locked_at < (select before from stale))
         and not exists (
           select 1 from aai_platform.workflow_queue o
           where o.slug = q.slug
             and o.kind = 'workflow'
             and o.run_id = q.run_id
             and o.locked_at >= (select before from stale)
         )
       order by q.slug, q.run_id, q.available_at
     ),
     step_due as (
       select ranked.id, ranked.available_at
       from (
         select q.id, q.available_at, q.slug, q.run_id,
                row_number() over (
                  partition by q.slug, q.run_id
                  order by q.available_at, q.id
                ) as rn
         from aai_platform.workflow_queue q
         where q.available_at <= now()
           and q.kind = 'step'
           and q.run_id is not null
           and (q.locked_at is null or q.locked_at < (select before from stale))
       ) ranked
       left join (
         select o.slug, o.run_id, count(*) as n
         from aai_platform.workflow_queue o
         where o.kind = 'step'
           and o.locked_at >= (select before from stale)
         group by o.slug, o.run_id
       ) in_flight on in_flight.slug = ranked.slug and in_flight.run_id = ranked.run_id
       where ranked.rn <= greatest($3 - coalesce(in_flight.n, 0), 0)
     ),
     candidates as (
       select id from (
         select id, available_at from orchestration_due
         union all
         select id, available_at from step_due
       ) due order by available_at, id limit $1
     )
     select id from candidates`;

describeWithPg("workflow queue claim equivalence", () => {
  /** Three tenants, so a group is `(slug, run_id)` rather than just a run. */
  const SLUGS = ["wfqc-t1", "wfqc-t2", "wfqc-t3"];
  const fx = useQueueFixture(SLUGS);
  const sql: SqlExec = (q, params) => fx.sql()(q, params);

  const legacy = async (limit: number): Promise<string[]> => {
    const rows = await sql(LEGACY_CANDIDATES, [
      limit,
      String(QUEUE_CLAIM_STALE_MS),
      WORKFLOW_QUEUE_STEPS_PER_RUN,
    ]);
    return rows.map((r) => String(r.id)).sort(byCodeUnit);
  };

  const claimed = async (limit: number): Promise<string[]> => {
    const rows = await claimDue(sql, limit);
    return rows.map((m) => m.id).sort(byCodeUnit);
  };

  /**
   * One fixture with every shape the two arms disagree about if the rewrite is
   * wrong: colliding groups across three tenants, both kinds, rows not yet due,
   * a fresh claim (which hides its whole orchestration group and spends a step
   * budget), a STALE claim (which is reclaimable), a payload with no `runId`,
   * and a row with no `kind`.
   *
   * Due times are unique — see the module doc on ties.
   */
  const seedFixture = async (): Promise<void> => {
    await sql(
      `insert into aai_platform.workflow_queue
                 (id, slug, queue_name, kind, payload, available_at, locked_at)
               select 'q_' || lpad(i::text, 3, '0'),
                      ($1::text[])[1 + (i % 3)],
                      case when i % 2 = 0 then '__wkf_step_r' else '__wkf_workflow_r' end,
                      case when i % 2 = 0 then 'step' else 'workflow' end,
                      jsonb_build_object('runId', 'wrun_' || (i % 7)),
                      -- Unique per row, and every seventh one is in the FUTURE.
                      now() + ((case when i % 7 = 3 then 600 else -i end) || ' seconds')::interval,
                      case when i % 11 = 0 then now() - interval '5 seconds'
                           when i % 13 = 0 then now() - interval '10 minutes'
                           else null end
               from generate_series(1, 120) i`,
      [SLUGS],
    );
    // A group deep enough for the STEP BUDGET to bind: 14 due steps for one run,
    // three of them already claimed. Without it the budget predicate is dead
    // weight in both statements — a fixture spreading 200 rows over 18 groups
    // averages ~5 due steps each, so `greatest($3 - n, 0)` never binds and a
    // mutation deleting it passes the differential. Verified by A/B.
    await sql(
      `insert into aai_platform.workflow_queue
         (id, slug, queue_name, kind, payload, available_at, locked_at)
       select 'q_deep_' || i, $1, '__wkf_step_r', 'step', '{"runId":"wrun_deep"}'::jsonb,
              now() - ((300 + i) || ' seconds')::interval,
              case when i <= 3 then now() - interval '5 seconds' else null end
       from generate_series(1, 14) i`,
      [SLUGS[1] as string],
    );
    // Two rows the claim must ignore for reasons unrelated to grouping: no
    // `runId` in the payload (so the generated `run_id` is null) and no `kind`.
    await sql(
      `insert into aai_platform.workflow_queue
                 (id, slug, queue_name, kind, payload, available_at)
               values ('q_norun', $1, '__wkf_workflow_x', 'workflow', '{}'::jsonb, now()),
                      ('q_nokind', $1, 'something-else', null, '{"runId":"wrun_9"}'::jsonb, now())`,
      [SLUGS[0] as string],
    );
    await sql("analyze aai_platform.workflow_queue");
  };

  const reset = async (): Promise<void> => {
    await sql("delete from aai_platform.workflow_queue");
    await seedFixture();
  };

  /**
   * One reproducible random fixture: 200 rows over three tenants and two runs
   * each, both kinds, a fifth of them not yet due, a quarter claimed at some
   * point inside or outside the stale window.
   *
   * TWO runs per tenant and not six: six groups over 200 rows puts ~16 due steps
   * in each, which is what makes {@link WORKFLOW_QUEUE_STEPS_PER_RUN} bind.
   * Due times are unique — see the module doc on ties.
   */
  const seedRandom = async (seed: number): Promise<void> => {
    await sql("delete from aai_platform.workflow_queue");
    await sql("select setseed($1)", [seed / 100]);
    await sql(
      `insert into aai_platform.workflow_queue
         (id, slug, queue_name, kind, payload, available_at, locked_at)
       select 'q_' || i,
              ($1::text[])[1 + floor(random() * 3)::int],
              case when r < 0.5 then '__wkf_step_r' else '__wkf_workflow_r' end,
              case when r < 0.5 then 'step' else 'workflow' end,
              jsonb_build_object('runId', 'wrun_' || floor(random() * 2)::int),
              now() + ((case when random() < 0.2 then 600 else -i end) || ' seconds')::interval,
              case when random() < 0.25
                   then now() - (floor(random() * 400) || ' seconds')::interval
                   else null end
       from (select i, random() r from generate_series(1, 200) i) t`,
      [SLUGS],
    );
    await sql("analyze aai_platform.workflow_queue");
  };

  /**
   * The candidate set is width-independent in the sense that matters: whatever
   * `limit` the sweep asks for, the rewrite claims the rows the old selection
   * would have. 1 and 2 are narrower than one run's fan-out, 8 is
   * `WORKFLOW_QUEUE_STEPS_PER_RUN`, and 200 is wider than the whole due set.
   */
  test("the rewrite claims the legacy candidate set at every width", async () => {
    for (const limit of [1, 2, 3, 8, 16, 32, 64, 200]) {
      await reset();
      const before = await legacy(limit);
      // Read-only, so the claim below sees the same state the baseline did.
      const after = await claimed(limit);
      expect(after, `limit ${limit}`).toEqual(before);
      // A width that cannot be filled is a real answer, not a vacuous pass: the
      // fixture has enough due rows to saturate every width below the last.
      if (limit <= 16) expect(after.length, `limit ${limit} saturated`).toBe(limit);
    }
  });

  /**
   * A randomised differential over the same shapes, because a hand-built fixture
   * only ever contains the cases its author thought of — and the rewrite's risk
   * is concentrated in exactly the interactions between grouping, the stale
   * cutoff and the step budget that are tedious to enumerate.
   *
   * `setseed` makes each fixture reproducible from its index, so a failure names
   * the seed that produced it.
   */
  test("a randomised differential finds no divergence", async () => {
    const SEEDS = 24;
    // BOTH widths, because they exercise different halves. At the sweep's own
    // width the answer is the global oldest 8, so one group's internal budget is
    // usually invisible; a width wider than the whole due set is where the step
    // budget and the per-group dedup decide the entire answer. A/B'd — the
    // narrow width alone misses a `claimDue` that stops charging in-flight steps
    // against the fan-out budget.
    const WIDTHS = [WORKFLOW_QUEUE_STEPS_PER_RUN, 500];
    const diverged: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      for (const limit of WIDTHS) {
        // Re-seeded per width rather than unlocking what the last claim took:
        // `setseed` makes the insert reproducible, so each width really does see
        // the same fixture, stale locks and all, instead of one the previous
        // claim has edited.
        await seedRandom(seed);
        const before = await legacy(limit);
        const after = await claimed(limit);
        if (before.join(",") !== after.join(",")) diverged.push(`seed ${seed} @ ${limit}`);
      }
    }
    expect(diverged).toEqual([]);
  });

  /**
   * The step budget, stated directly, because a differential can only compare
   * two statements that agree — and both of these carry the same budget
   * expression, so a fixture where it never binds passes whatever it says. A/B'd:
   * replacing `greatest($3 - n, 0)` with `$3` in `claimDue` passes the two
   * differentials above until their fixtures put more than
   * `WORKFLOW_QUEUE_STEPS_PER_RUN` due steps in one group.
   */
  test("one run's in-flight steps are charged against its fan-out budget", async () => {
    const IN_FLIGHT = 3;
    await sql(
      `insert into aai_platform.workflow_queue
         (id, slug, queue_name, kind, payload, available_at, locked_at)
       select 'b_' || lpad(i::text, 2, '0'), $1, '__wkf_step_r', 'step',
              '{"runId":"wrun_budget"}'::jsonb,
              now() - ((100 + i) || ' seconds')::interval,
              case when i <= $2 then now() - interval '5 seconds' else null end
       from generate_series(1, 20) i`,
      [SLUGS[0] as string, IN_FLIGHT],
    );
    // Wide enough that the width is not what bounds the answer — the budget is.
    const ids = (await claimDue(sql, 200)).map((m) => m.id);
    expect(ids).toHaveLength(WORKFLOW_QUEUE_STEPS_PER_RUN - IN_FLIGHT);
    // Oldest-due first among the unclaimed, which here is highest `i`.
    expect(ids[0]).toBe("b_20");
  });

  test("a tie inside one run claims the lower id", async () => {
    await sql(
      `insert into aai_platform.workflow_queue (id, slug, queue_name, kind, payload, available_at)
       select 'tie_' || i, $1, '__wkf_workflow_r', 'workflow',
              '{"runId":"wrun_tie"}'::jsonb, now() - interval '1 second'
       from generate_series(1, 4) i`,
      [SLUGS[0] as string],
    );
    expect((await claimDue(sql, 10)).map((m) => m.id)).toEqual(["tie_1"]);
  });
});
