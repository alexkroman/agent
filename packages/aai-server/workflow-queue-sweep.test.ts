// Copyright 2026 the AAI authors. MIT license.
/**
 * The delivery pass's POLICY, with the store faked.
 *
 * What is asserted here is the part that is pure decision — one unreachable guest
 * not costing the others their tick, a failure becoming a backoff rather than a
 * loss, a draining replica claiming nothing. The SQL half has its own suite
 * against a real Postgres (`workflow-queue-store.scenario.test.ts`); a fake here
 * would only re-assert the statements we wrote.
 */

import { sleep } from "@alexkroman1/aai/internal";
import { describe, expect, test, vi } from "vitest";
import type { AdminDb } from "./platform-lock.ts";
import { captureLogs, fakeAdminDbOver } from "./test-utils.ts";
import type { QueuedMessage } from "./workflow-queue-store.ts";
import { type Delivered, runQueuePass } from "./workflow-queue-sweep.ts";

const logs = captureLogs();

/** A message as `claimDue` returns one. */
/**
 * The uninteresting delivery outcome, named so the specs about something ELSE
 * do not restate it. A bare `async () => {}` no longer satisfies
 * `DeliverMessage`, which is the point of making the outcome a union.
 */
const completes = async (): Promise<Delivered> => ({ type: "completed" });

function msg(id: string, over: Partial<QueuedMessage> = {}): QueuedMessage {
  return { id, slug: "t1", queueName: `__wkf_workflow_${id}`, payload: {}, attempt: 0, ...over };
}

/**
 * An `AdminDb` whose claim answers `claimed` once, and which records every
 * statement so the settle half can be asserted.
 *
 * The claim is matched on `distinct on`, which is the shape only `claimDue`
 * issues — keying on a fragment of our own SQL rather than on call order, so a
 * pass that issued its statements in a different sequence still reads correctly.
 */
function fakeDb(claimed: QueuedMessage[]): {
  db: AdminDb;
  statements: string[];
  released: () => number;
} {
  const statements: string[] = [];
  let handed = false;
  let released = 0;
  const inner = fakeAdminDbOver((sql) => {
    statements.push(sql);
    if (sql.includes("distinct on")) {
      if (handed) return [];
      handed = true;
      return claimed.map((m) => ({
        id: m.id,
        slug: m.slug,
        queue_name: m.queueName,
        payload: m.payload,
        headers: null,
        deployment_id: null,
        attempt: m.attempt,
      }));
    }
    return [];
  });
  const db: AdminDb = {
    reserve: async () => {
      const r = await inner.reserve();
      return {
        query: r.query,
        release: () => {
          released += 1;
          r.release();
        },
      };
    },
  };
  return { db, statements, released: () => released };
}

describe("runQueuePass", () => {
  test("does nothing without a platform database", async () => {
    const deliver = vi.fn(completes);
    expect(await runQueuePass({ deliver })).toEqual({
      claimed: 0,
      delivered: 0,
      rescheduled: 0,
      retried: 0,
      dropped: 0,
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  test("a draining replica claims nothing", async () => {
    // Same predicate `/health` reports on: a replica told to stop routing must
    // not take on work it may not finish before it exits.
    const { db, statements } = fakeDb([msg("m1")]);
    const deliver = vi.fn(completes);
    const pass = await runQueuePass({ adminDb: db, deliver, isDraining: () => true });
    expect(pass.claimed).toBe(0);
    expect(statements).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
  });

  test("an empty claim delivers nothing and reserves no second connection", async () => {
    const { db, released } = fakeDb([]);
    const deliver = vi.fn(completes);
    expect(await runQueuePass({ adminDb: db, deliver })).toEqual({
      claimed: 0,
      delivered: 0,
      rescheduled: 0,
      retried: 0,
      dropped: 0,
    });
    // One reservation for the claim, and none for a settle that has nothing to do.
    expect(released()).toBe(1);
  });

  test("delivers each claimed message and acks it", async () => {
    const { db, statements } = fakeDb([msg("m1"), msg("m2")]);
    const seen: string[] = [];
    const pass = await runQueuePass({
      adminDb: db,
      deliver: async (m) => {
        seen.push(m.id);
        return { type: "completed" };
      },
    });
    expect(pass).toEqual({ claimed: 2, delivered: 2, rescheduled: 0, retried: 0, dropped: 0 });
    expect(seen.sort((a, b) => a.localeCompare(b))).toEqual(["m1", "m2"]);
    expect(statements.filter((s) => s.startsWith("delete from"))).toHaveLength(2);
  });

  /**
   * The property this pass exists to have: one unreachable guest must not cost
   * every other tenant its tick. A `Promise.all` that rejected on the first
   * failure would abandon the rest of the batch CLAIMED, so they would sit
   * invisible until the staleness window.
   */
  test("one failing delivery does not stop the others", async () => {
    const { db } = fakeDb([msg("bad"), msg("good1"), msg("good2")]);
    const delivered: string[] = [];
    const pass = await runQueuePass({
      adminDb: db,
      deliver: async (m) => {
        if (m.id === "bad") throw new Error("guest unreachable");
        delivered.push(m.id);
        return { type: "completed" };
      },
    });
    expect(delivered.sort((a, b) => a.localeCompare(b))).toEqual(["good1", "good2"]);
    expect(pass).toEqual({ claimed: 3, delivered: 2, rescheduled: 0, retried: 1, dropped: 0 });
  });

  test("a failure becomes a backoff, not a delete", async () => {
    const { db, statements } = fakeDb([msg("m1")]);
    const pass = await runQueuePass({
      adminDb: db,
      deliver: async () => {
        throw new Error("nope");
      },
    });
    expect(pass.retried).toBe(1);
    // Updated (attempt + available_at), never deleted — a lost message is a
    // stalled run.
    expect(statements.some((s) => s.includes("set attempt ="))).toBe(true);
    expect(statements.some((s) => s.startsWith("delete from"))).toBe(false);
  });

  test("a message past its retry budget is abandoned, and says so", async () => {
    // Reported at `warn` rather than swallowed: the run is stalled until
    // something else boots its agent, which is not something to discover later.
    const { db } = fakeDb([msg("m1", { attempt: 99 })]);
    const pass = await runQueuePass({
      adminDb: db,
      deliver: async () => {
        throw new Error("nope");
      },
    });
    expect(pass).toEqual({ claimed: 1, delivered: 0, rescheduled: 0, retried: 0, dropped: 1 });
    expect(logs.warns().join(" ")).toContain("abandoned 1 message(s)");
  });

  test("a healthy pass logs nothing an operator has to read", async () => {
    const { db } = fakeDb([msg("m1")]);
    await runQueuePass({ adminDb: db, deliver: completes });
    expect(logs.warns()).toEqual([]);
    expect(logs.infos()).toEqual([]);
  });

  /**
   * The claim's connection is RELEASED before any delivery starts. A delivery is
   * an HTTP request into a guest and may take seconds; holding a pooled
   * connection across the batch is how one slow guest becomes a connection
   * shortage for every platform read.
   */
  test("the claim's connection is not held across deliveries", async () => {
    const { db, released } = fakeDb([msg("m1")]);
    let releasedAtDelivery = -1;
    await runQueuePass({
      adminDb: db,
      deliver: async () => {
        releasedAtDelivery = released();
        return { type: "completed" };
      },
    });
    // The claim's reservation is already back before the first delivery runs.
    expect(releasedAtDelivery).toBeGreaterThanOrEqual(1);
  });

  test("delivery concurrency is bounded", async () => {
    const { db } = fakeDb(Array.from({ length: 12 }, (_, i) => msg(`m${i}`)));
    let inFlight = 0;
    let peak = 0;
    await runQueuePass({
      adminDb: db,
      concurrency: 3,
      deliver: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep(5);
        inFlight -= 1;
        return { type: "completed" };
      },
    });
    expect(peak).toBeLessThanOrEqual(3);
    // And it really did overlap — a bound of three that ran serially would pass
    // the assertion above while proving nothing.
    expect(peak).toBeGreaterThan(1);
  });
});

describe("a run that parked itself", () => {
  /**
   * `sleep()` is the third outcome, and getting it wrong is invisible.
   *
   * The DevKit's queue callback answers 200 with `{"timeoutSeconds": n}` when
   * the run parked. Acking that message strands the run forever with nothing
   * logged; failing it works for a few minutes and then abandons the run at the
   * retry budget, which reads as a delivery fault rather than a sleep.
   */
  test("is rescheduled rather than acked", async () => {
    const { db, statements } = fakeDb([msg("m1")]);
    const pass = await runQueuePass({
      adminDb: db,
      deliver: async () => ({ type: "reschedule", delaySeconds: 90 }),
    });
    expect(pass).toEqual({ claimed: 1, delivered: 0, rescheduled: 1, retried: 0, dropped: 0 });
    // NOT deleted: the message has to come back.
    expect(statements.some((s) => s.startsWith("delete from"))).toBe(false);
    expect(statements.some((s) => s.includes("set locked_at = null"))).toBe(true);
  });

  /**
   * A sleeping run consumes NO retry budget. Charging it one would cap the
   * number of times a workflow may sleep at `QUEUE_MAX_ATTEMPTS` — five — and
   * the sixth `sleep()` would abandon the run.
   */
  test("does not spend an attempt, however many times it sleeps", async () => {
    const { db, statements } = fakeDb([msg("m1", { attempt: 4 })]);
    const pass = await runQueuePass({
      adminDb: db,
      deliver: async () => ({ type: "reschedule", delaySeconds: 5 }),
    });
    // attempt 4 of a 5-attempt budget: read as a failure this would be DROPPED.
    expect(pass).toEqual({ claimed: 1, delivered: 0, rescheduled: 1, retried: 0, dropped: 0 });
    expect(statements.some((s) => s.includes("set attempt ="))).toBe(false);
    expect(logs.warns()).toEqual([]);
  });

  test("is not reported as an operational event", async () => {
    const { db } = fakeDb([msg("m1")]);
    await runQueuePass({
      adminDb: db,
      deliver: async () => ({ type: "reschedule", delaySeconds: 3600 }),
    });
    // An hour-long sleep is a healthy workflow, not something to page about.
    expect(logs.warns()).toEqual([]);
    expect(logs.infos()).toEqual([]);
  });

  test("a sleep beside a failure and a success settles each on its own terms", async () => {
    const { db } = fakeDb([msg("sleeper"), msg("done"), msg("broken")]);
    const pass = await runQueuePass({
      adminDb: db,
      deliver: async (m) => {
        if (m.id === "broken") throw new Error("guest unreachable");
        if (m.id === "sleeper") return { type: "reschedule", delaySeconds: 30 };
        return { type: "completed" };
      },
    });
    expect(pass).toEqual({ claimed: 3, delivered: 1, rescheduled: 1, retried: 1, dropped: 0 });
  });
});
