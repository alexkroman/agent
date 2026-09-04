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
import { claimDue } from "./workflow-queue-claim.ts";
import { GuestUnreachableError } from "./workflow-queue-failure.ts";
import { startWorkflowQueueSweep } from "./workflow-queue-scheduler.ts";
import type { QueuedMessage } from "./workflow-queue-store.ts";
import { type Delivered, runQueuePass } from "./workflow-queue-sweep.ts";

const logs = captureLogs();

/**
 * The fragment that identifies `claimDue`'s statement to the fakes below.
 *
 * A CTE NAME rather than an operator, and the test at the bottom of this file is
 * why. It was `distinct on` — the shape only the claim issued — and the claim's
 * anti-join rewrite deleted that operator, which the fakes could not notice:
 * twelve tests failed with `claimed: 0` and nothing pointing at the cause, and
 * one ("a notification does not queue an unbounded number of passes") went
 * VACUOUSLY GREEN, its `filter(s => s.includes(…)).length <= 2` counting zero
 * matches of a fragment nothing emitted any more.
 *
 * A substring is still the right coupling — keying on call ORDER makes a pass
 * that reorders its statements read wrongly — so what changed is that the
 * coupling is now CHECKED. `orchestration_due` is the claim's own CTE, so a
 * rewrite that renames it fails one named test with a message saying so.
 */
const CLAIM_SQL_KEY = "orchestration_due";

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
 * The claim is matched on {@link CLAIM_SQL_KEY} — a fragment of our own SQL
 * rather than a call ORDER, so a pass that issued its statements in a different
 * sequence still reads correctly. That fragment's own doc carries what it costs
 * when it stops matching, and the last test in this file is what stops it.
 */
function fakeDb(claimed: QueuedMessage[]): {
  db: AdminDb;
  statements: string[];
  released: () => number;
  /**
   * Connections reserved and not yet given back.
   *
   * The count that matters for the pool, and the one {@link released} cannot
   * express: a pass that reserves twice and releases once has `released() === 1`
   * and is holding a connection.
   */
  held: () => number;
  /** Fire the NOTIFY the sweep subscribed with. */
  notify: () => void;
  /** How many subscriptions were torn down — a stop that leaks one is a leak. */
  unlistened: () => number;
} {
  const statements: string[] = [];
  let handed = false;
  let released = 0;
  let held = 0;
  const notifiers: (() => void)[] = [];
  let unlistened = 0;
  const inner = fakeAdminDbOver((sql) => {
    statements.push(sql);
    if (sql.includes(CLAIM_SQL_KEY)) {
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
    // `failUnreachable` reads its NEW counter out of a `returning`, so a fake
    // answering `[]` would make every unreachable settle look like the counter
    // was already spent — i.e. the drop path, on the first attempt, in every
    // unit test. One is the honest answer for a message failing for the first
    // time; the budget's own edges belong to the real-Postgres suite.
    if (sql.includes("unreachable_attempts")) return [{ unreachable_attempts: 1 }];
    return [];
  });
  const db: AdminDb = {
    // Captured rather than ignored: the notification path's specs drive the sweep
    // by INVOKING this callback, which is what lets them assert "a NOTIFY runs a
    // pass" without a Postgres.
    listen: (_channel, onNotify) => {
      notifiers.push(onNotify);
      return Promise.resolve(() => {
        unlistened += 1;
      });
    },
    reserve: async () => {
      const r = await inner.reserve();
      held += 1;
      return {
        query: r.query,
        release: () => {
          released += 1;
          held -= 1;
          r.release();
        },
      };
    },
  };
  return {
    db,
    statements,
    released: () => released,
    held: () => held,
    notify: () => {
      for (const fire of notifiers) fire();
    },
    unlistened: () => unlistened,
  };
}

/**
 * Let the sweep's `listen()` promise settle.
 *
 * `startWorkflowQueueSweep` subscribes without awaiting — it returns a stop
 * synchronously — so the callback is not captured until a microtask has run. One
 * `flush()` would do it today; `vi.waitFor` is used at the assertion sites instead
 * so nothing depends on how many ticks the chain happens to take.
 */
const flushListen = (): Promise<void> => Promise.resolve();

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

  test("NO connection is held across a delivery, not merely the claim's", async () => {
    // The case above counts RELEASES, which the claim's own release satisfies —
    // so it passed while the settle phase reserved a second connection before
    // the fan-out and released it only after every delivery had resolved. That
    // is the shortage the paragraph above describes, arriving one phase later:
    // at the defaults (32 a tick, 8 in flight) against guests that are timing
    // out, one pass pinned a connection for minutes out of ADMIN_POOL_MAX = 16,
    // which every platform read on the replica shares.
    const { db, held } = fakeDb(Array.from({ length: 6 }, (_, i) => msg(`m${i}`)));
    let peakDuringDelivery = 0;
    await runQueuePass({
      adminDb: db,
      concurrency: 3,
      deliver: async () => {
        peakDuringDelivery = Math.max(peakDuringDelivery, held());
        await sleep(5);
        peakDuringDelivery = Math.max(peakDuringDelivery, held());
        return { type: "completed" };
      },
    });
    expect(peakDuringDelivery).toBe(0);
    // And the pass really did settle each message, so the zero above is "nothing
    // was held" rather than "nothing happened".
    expect(held()).toBe(0);
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

/**
 * The NOTIFY half — a latency optimization that must not become the record.
 *
 * `enqueue` announces on `WORKFLOW_QUEUE_CHANNEL` when a message is due now, and
 * the sweep listens so a step-to-step hop stops paying the poll interval. Every
 * spec here is about the boundary of that: what it speeds up, what it must not
 * replace, and what happens when it is unavailable.
 *
 * The listener is driven by INVOKING the callback the fake captured, so none of
 * this needs a Postgres — the wire is `postgres-db.ts`'s `listen`, and the fact
 * that a real notification arrives is the scenario tier's business.
 */
/**
 * A SLOW delivery must not stop the replica claiming for everybody else.
 *
 * The pass awaits every delivery it claimed and a delivery is bounded only by
 * `QUEUE_DELIVERY_TIMEOUT_MS` (60 s), because it runs a tenant's step inline. The
 * interval used to drop a tick while a pass was in flight, so one slow step
 * anywhere on the replica stopped every other tenant's message from being
 * claimed for up to a minute — measured on a dev server at 21.1 s for a
 * two-step, wait-free workflow against 0.5 s idle, cross-tenant.
 *
 * `workflow-queue-budget.ts` is the fix and carries the argument. What is
 * asserted here is the property, not the mechanism: a second message becomes
 * claimable while the first delivery is still in flight, and it is delivered.
 */
describe("a slow delivery", () => {
  /**
   * An `AdminDb` whose claim answers one message per call, in order.
   *
   * `fakeDb` above hands its whole batch to the FIRST claim and nothing after,
   * which cannot express "a message arrived while a delivery was running" — the
   * only shape this defect has.
   */
  function fakeDbPerClaim(batches: QueuedMessage[][]): { db: AdminDb; claims: () => number } {
    let claims = 0;
    const inner = fakeAdminDbOver((sql) => {
      if (!sql.includes(CLAIM_SQL_KEY)) return [];
      const batch = batches[claims++] ?? [];
      return batch.map((m) => ({
        id: m.id,
        slug: m.slug,
        queue_name: m.queueName,
        payload: m.payload,
        headers: null,
        deployment_id: null,
        attempt: m.attempt,
      }));
    });
    return {
      db: { reserve: inner.reserve, listen: () => Promise.resolve(() => undefined) },
      claims: () => claims,
    };
  }

  test("does not stop the next message from being claimed and delivered", async () => {
    const { db } = fakeDbPerClaim([[msg("slow")], [msg("next")]]);
    const holding = Promise.withResolvers<Delivered>();
    const started: string[] = [];
    const stop = startWorkflowQueueSweep({
      adminDb: db,
      intervalMs: 5,
      deliver: async (m) => {
        started.push(m.id);
        // The slow one never settles until this test lets it, which is what a
        // 60-second step looks like to the sweep.
        return m.id === "slow" ? await holding.promise : { type: "completed" };
      },
    });
    try {
      await vi.waitFor(() => expect(started).toContain("next"));
      // And the slow delivery really was still in flight — a `next` delivered
      // only after `slow` settled would satisfy the line above while proving
      // nothing.
      expect(started).toEqual(["slow", "next"]);
    } finally {
      holding.resolve({ type: "completed" });
      stop();
    }
  });

  /**
   * The bound is on DELIVERIES, so a saturated replica stops claiming — and it
   * must stop before it reserves a connection, since a tick during a slow
   * delivery is now the ordinary case rather than the rare one.
   */
  test("holds the claim once every delivery slot is taken", async () => {
    const { db, claims } = fakeDbPerClaim([[msg("a")], [msg("b")], [msg("c")]]);
    const holding = Promise.withResolvers<Delivered>();
    const started: string[] = [];
    const stop = startWorkflowQueueSweep({
      adminDb: db,
      intervalMs: 5,
      // Two slots for the whole replica, and both go to deliveries that never
      // settle.
      concurrency: 2,
      deliver: async (m) => {
        started.push(m.id);
        return await holding.promise;
      },
    });
    try {
      await vi.waitFor(() => expect(started).toEqual(["a", "b"]));
      const claimsWhenFull = claims();
      await sleep(60);
      // Ticks kept firing and every one of them declined to claim.
      expect(started).toEqual(["a", "b"]);
      expect(claims()).toBe(claimsWhenFull);
    } finally {
      holding.resolve({ type: "completed" });
      stop();
    }
  });
});

describe("delivery on NOTIFY", () => {
  /** A sweep whose interval is long enough that no tick can fire during a test. */
  const startIdle = (db: AdminDb, deliver = vi.fn(completes)) => ({
    stop: startWorkflowQueueSweep({ adminDb: db, deliver, intervalMs: 600_000 }),
    deliver,
  });

  test("a notification runs a pass without waiting for the interval", async () => {
    const { db, notify } = fakeDb([msg("m1")]);
    const { stop, deliver } = startIdle(db);
    await flushListen();
    notify();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    stop();
  });

  /**
   * A burst COALESCES, which is why the runner sits behind the NOTIFY trigger.
   *
   * Concurrent passes are not incorrect — `claimDue` re-checks its predicate under
   * the row lock, so N passes take disjoint sets — they are wasted. Ten enqueues
   * landing together must not start ten passes, and `createCoalescingRunner`
   * collapses them to the one in flight plus one trailing. The INTERVAL
   * deliberately does not share it; see the starvation spec below.
   */
  test("a burst of notifications does not start a pass each", async () => {
    const { db, statements, notify } = fakeDb([]);
    const { stop } = startIdle(db);
    await flushListen();
    for (let i = 0; i < 10; i++) notify();
    await vi.waitFor(() => expect(statements.length).toBeGreaterThan(0));
    // At most two claims: the in-flight one and a single trailing run. Asserted as
    // a ceiling rather than an exact count because which of the ten lands during
    // the first pass is a scheduling detail — the property is that it is bounded,
    // not that it is 2.
    expect(statements.filter((s) => s.includes(CLAIM_SQL_KEY)).length).toBeLessThanOrEqual(2);
    stop();
  });

  test("stopping the sweep tears the subscription down", async () => {
    // A listener left behind a stopped sweep holds a connection this replica has
    // stopped accounting for, and keeps running passes during a drain.
    const { db, unlistened } = fakeDb([]);
    const { stop } = startIdle(db);
    await flushListen();
    stop();
    expect(unlistened()).toBe(1);
  });

  /**
   * A subscription that cannot be established DEGRADES, and says so.
   *
   * The interval alone still delivers every message, so this is slower rather than
   * broken — and the log line has to say that, because "queue NOTIFY subscription
   * failed" alone reads like durable workflows have stopped.
   */
  test("a failed subscription leaves the interval delivering, and warns", async () => {
    const { db } = fakeDb([]);
    const failing: AdminDb = {
      reserve: db.reserve,
      listen: () => Promise.reject(new Error("no connection")),
    };
    const stop = startWorkflowQueueSweep({
      adminDb: failing,
      deliver: vi.fn(completes),
      intervalMs: 600_000,
    });
    await vi.waitFor(() => expect(logs.warns()).toHaveLength(1));
    expect(logs.warns()[0]).toContain("poll");
    expect(logs.warns()[0]).toContain("loses nothing");
    expect(stop).not.toThrow();
  });

  /**
   * A pass that THROWS is reported rather than becoming an unhandled rejection.
   *
   * Note what does NOT reach this: a failing DELIVERY is handled inside
   * `runQueuePass`, which turns it into a backoff — so the hazard is a pass that
   * cannot even claim, i.e. the connection itself. The interval's trigger is
   * covered by `startWorkflowQueueSweep`'s specs; this path calls the runner
   * directly and is the one that needed its own catch.
   */
  test("a pass that cannot claim is reported, not left as an unhandled rejection", async () => {
    const { db, notify } = fakeDb([]);
    const broken: AdminDb = {
      listen: db.listen,
      reserve: () => Promise.reject(new Error("connect ECONNREFUSED")),
    };
    const stop = startWorkflowQueueSweep({
      adminDb: broken,
      deliver: vi.fn(completes),
      intervalMs: 600_000,
    });
    await flushListen();
    notify();
    await vi.waitFor(() =>
      expect(logs.warns().some((w) => w.includes("notified queue pass failed"))).toBe(true),
    );
    expect(stop).not.toThrow();
  });
});

/**
 * WHICH budget a failed delivery spends, which is the sweep's decision and no
 * one else's.
 *
 * `workflow-queue-failure.ts` owns the two budgets and the argument; what is
 * asserted here is the routing, because it is the half a wrong `instanceof`
 * silently breaks — and breaks in the direction that looks fine, since both
 * paths back off and only one of them drops a message six minutes early.
 */
describe("a failed delivery is charged to the right budget", () => {
  /** The statement each settle issues, so the routing is read off the SQL. */
  const settledWith = (statements: string[]): string[] =>
    statements.filter(
      (sql) => sql.includes("set attempt =") || sql.includes("unreachable_attempts"),
    );

  test("a guest that ANSWERED wrongly spends the message's own attempts", async () => {
    const { db, statements } = fakeDb([msg("m1")]);
    await runQueuePass({
      adminDb: db,
      deliver: () => Promise.reject(new Error("guest answered HTTP 500: boom")),
    });
    expect(settledWith(statements)).toHaveLength(1);
    expect(settledWith(statements)[0]).toContain("set attempt =");
  });

  test("a guest that was never REACHED spends the patient budget instead", async () => {
    // The broker answering 503 because a boot is still in flight: nothing was
    // asked, so nothing has been learned about this message.
    const { db, statements } = fakeDb([msg("m1")]);
    await runQueuePass({
      adminDb: db,
      deliver: () => Promise.reject(new GuestUnreachableError("broker refused t1: HTTP 503")),
    });
    expect(settledWith(statements)).toHaveLength(1);
    expect(settledWith(statements)[0]).toContain("unreachable_attempts");
    // And NOT the message's own counter, which is the whole point.
    expect(statements.some((sql) => sql.includes("set attempt ="))).toBe(false);
  });

  test("a transport throw stays on the STRICTER budget, being ambiguous", async () => {
    // A `fetch` that throws may mean the guest received the message and is
    // running the step. `workflow-queue-deliver.ts` therefore does not classify
    // it as unreachable, and this pins that a bare Error does not drift into the
    // patient budget by accident.
    const { db, statements } = fakeDb([msg("m1")]);
    await runQueuePass({
      adminDb: db,
      deliver: () => Promise.reject(new TypeError("fetch failed")),
    });
    expect(settledWith(statements)[0]).toContain("set attempt =");
  });

  test("the pass reports it as a retry either way, so a caller's counts hold", async () => {
    const { db } = fakeDb([msg("m1")]);
    const pass = await runQueuePass({
      adminDb: db,
      deliver: () => Promise.reject(new GuestUnreachableError("broker refused t1: HTTP 503")),
    });
    expect(pass).toMatchObject({ claimed: 1, delivered: 0, retried: 1, dropped: 0 });
  });
});

/**
 * The fakes above answer a claim by matching {@link CLAIM_SQL_KEY} against the
 * statement, so a `claimDue` that stopped containing it would make every one of
 * them answer "nothing due" — which is a suite that tests the sweep against a
 * queue that is never non-empty. It has happened once; this is what turns it into
 * one failure that names the fragment.
 *
 * Deliberately asserted against the REAL `claimDue` rather than against a
 * constant it exports: a key the subject hands out cannot go stale, and cannot
 * catch this either.
 */
test("the claim fragment the fakes key on is one `claimDue` really issues", async () => {
  const issued: string[] = [];
  await claimDue(async (q) => {
    issued.push(q);
    return [];
  }, 1);
  expect(
    issued.filter((q) => q.includes(CLAIM_SQL_KEY)),
    `claimDue no longer contains "${CLAIM_SQL_KEY}" — update CLAIM_SQL_KEY`,
  ).toHaveLength(1);
});
