// Copyright 2026 the AAI authors. MIT license.
/**
 * The queue's TWO retry budgets, against a real Postgres.
 *
 * `workflow-queue-failure.ts` is where the split lives and carries the argument;
 * this is the half that only a server can answer. `failUnreachable` chooses its
 * delay by subscripting a `bigint[]` with the counter the same statement just
 * incremented, and clamps that subscript with `least` — so the two things worth
 * checking are that the right counter moves and that a subscript past the
 * table's end does not write a NULL `available_at`, which would make the message
 * invisible to every future claim with no error anywhere. A fake here would
 * assert the SQL we wrote, which is the thing under test.
 *
 * ## Its own suite, and its own DATABASE
 *
 * `workflow-queue-store.scenario.test.ts` reached the 700-line cap, and its doc
 * names the remedy: move a group out. This is that group — everything about what
 * a FAILED delivery costs, mirroring the source split. It gets a private
 * database from `useQueueFixture` for the reason recorded there: `claimDue` and
 * `WORKFLOW_QUEUE_CHANNEL` are both fleet-wide, so per-suite SLUGS isolate the
 * rows a test writes and nothing about the predicates that read them. That
 * mechanism is what makes a third suite over this surface possible at all.
 */

import { expect, test } from "vitest";
import { describeWithPg } from "./_pg-test-utils.ts";
import { useQueueFixture } from "./_workflow-queue-test-utils.ts";
import type { SqlExec } from "./secret-store.ts";
import { claimDue } from "./workflow-queue-claim.ts";
import {
  fail,
  failUnreachable,
  QUEUE_MAX_ATTEMPTS,
  QUEUE_MAX_UNREACHABLE_ATTEMPTS,
} from "./workflow-queue-failure.ts";
import { enqueue } from "./workflow-queue-store.ts";

describeWithPg("workflow queue retry budgets", () => {
  /** This suite's OWN tenants — see the fixture's doc for why they are not shared. */
  const fx = useQueueFixture(["wfqf-t1"]);
  const sql: SqlExec = (q, params) => fx.sql()(q, params);
  const msg = fx.msg;

  test("a failed delivery backs off, then is abandoned at the budget", async () => {
    await enqueue(sql, msg("m1", "r1"));
    const [claimed] = await claimDue(sql, 1);
    expect(await fail(sql, claimed?.id ?? "", claimed?.attempt ?? 0)).toBe("retry");
    // Backed off, so not immediately due again — and unclaimed, so a later sweep
    // can take it.
    expect(await claimDue(sql, 10)).toEqual([]);
    const rows = await sql("select attempt, locked_at from aai_platform.workflow_queue");
    expect(rows[0]?.attempt).toBe(1);
    expect(rows[0]?.locked_at).toBeNull();

    expect(await fail(sql, "m1", QUEUE_MAX_ATTEMPTS - 1)).toBe("dropped");
    const after = await sql("select count(*)::int as n from aai_platform.workflow_queue");
    expect(after[0]?.n).toBe(0);
  });

  /**
   * The SECOND budget, against the column and the array subscript that drive it.
   *
   * Only a real Postgres can check this: the delay comes from a `bigint[]`
   * subscripted by the counter the same statement just incremented, and `least`
   * clamping that subscript is what stops a row past the table's end writing a
   * NULL `available_at` — a message permanently invisible to every claim. A fake
   * would only re-assert the SQL we wrote.
   */
  test("an unreachable delivery spends its own budget, not the message's", async () => {
    await enqueue(sql, msg("m1", "r1"));
    const [claimed] = await claimDue(sql, 1);
    expect(await failUnreachable(sql, claimed?.id ?? "")).toBe("retry");
    const rows = await sql(
      `select attempt, unreachable_attempts, locked_at, available_at > now() as later
         from aai_platform.workflow_queue`,
    );
    // The patient counter moved and the message's own did NOT. That is the whole
    // change: a boot still in flight says nothing about this message.
    expect(rows[0]?.unreachable_attempts).toBe(1);
    expect(rows[0]?.attempt).toBe(0);
    // Backed off and unclaimed, so a later sweep takes it.
    expect(rows[0]?.locked_at).toBeNull();
    expect(rows[0]?.later).toBe(true);
    expect(await claimDue(sql, 10)).toEqual([]);
  });

  test("its backoff LENGTHENS with the counter, so a blip is not a hot loop", async () => {
    await enqueue(sql, msg("m1", "r1"));
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      await failUnreachable(sql, "m1");
      const rows = await sql(
        `select extract(epoch from (available_at - now())) as secs
           from aai_platform.workflow_queue`,
      );
      delays.push(Number(rows[0]?.secs));
    }
    // Increasing across the table's first three entries. Asserted as a SHAPE
    // rather than as exact numbers, so retuning the table is not a test edit —
    // what must hold is that it backs off.
    expect(delays[1]).toBeGreaterThan(delays[0] as number);
    expect(delays[2]).toBeGreaterThan(delays[1] as number);
  });

  test("and it abandons eventually, rather than retrying an absent guest forever", async () => {
    await enqueue(sql, msg("m1", "r1"));
    // One short of the budget, set directly: walking there through
    // `failUnreachable` would take ten real minutes of backoff.
    await sql("update aai_platform.workflow_queue set unreachable_attempts = $1", [
      QUEUE_MAX_UNREACHABLE_ATTEMPTS - 1,
    ]);
    expect(await failUnreachable(sql, "m1")).toBe("dropped");
    expect(await sql("select count(*)::int as n from aai_platform.workflow_queue")).toEqual([
      { n: 0 },
    ]);
  });

  test("a counter past the table's end clamps rather than writing a null due time", async () => {
    // Reachable only by a hand-edited row, and the failure mode is the worst
    // available: a null `available_at` makes the message invisible to
    // `available_at <= now()` forever, with no error anywhere. `least` is what
    // prevents it, and without it this statement raises instead.
    await enqueue(sql, msg("m1", "r1"));
    await sql("update aai_platform.workflow_queue set unreachable_attempts = 99");
    await expect(failUnreachable(sql, "m1")).resolves.toBe("dropped");
  });

  /**
   * A message the guest REFUSED and one it never REACHED are settled by two
   * different functions, and nothing stops a caller charging both.
   *
   * Worth pinning because the counters are independent by construction, so a
   * message can legitimately carry some of each — a guest that booted late and
   * then threw. What must NOT happen is one function moving the other's counter.
   */
  test("the two counters are independent", async () => {
    await enqueue(sql, msg("m1", "r1"));
    await failUnreachable(sql, "m1");
    await fail(sql, "m1", 0);
    const rows = await sql("select attempt, unreachable_attempts from aai_platform.workflow_queue");
    expect(rows[0]).toMatchObject({ attempt: 1, unreachable_attempts: 1 });
  });
});
