// Copyright 2026 the AAI authors. MIT license.
/**
 * A SHORT park is no longer rounded up to the poll interval.
 *
 * `announce` used to say nothing at all about a future-dated row, on the sound
 * argument that a `NOTIFY` means "look now" and there is nothing to find until
 * `available_at` passes. That is right for a `sleep()` measured in minutes and
 * wrong for one measured in milliseconds: nothing announced a row parked for
 * 100 ms, so it waited for whenever the next tick happened to fall, and
 * `ctx.sleep("beat", 100)` and `ctx.sleep("beat", 900)` therefore resumed at the
 * SAME moment — one `WORKFLOW_QUEUE_INTERVAL_MS` from the enqueue on average,
 * per iteration of a poll-shaped body.
 *
 * Three pieces close it and each is asserted here, because each is silent when
 * broken and none of them fails a delivery:
 *
 * - **`announce` wakes a pass for a short park**, and still says nothing for a
 *   long one — a 30-second sleep announced would wake every replica to run a
 *   query that answers nothing, which is the original objection and still holds.
 * - **`msUntilNextDue` is what the woken pass LEARNS.** The notification carries
 *   no payload and must not: a duration read out of the table names no message,
 *   so nothing can be tempted into delivering FROM the signal.
 * - **The sweep arms ONE extra look** at that time, which is the only place "due
 *   at T" is ever expressed.
 *
 * Virtual time, because the whole subject is a schedule — see the root guide's
 * "A spec that observes a TIMER runs on virtual time".
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AdminDb } from "./platform-lock.ts";
import { captureLogs } from "./test-utils.ts";
import { startWorkflowQueueSweep } from "./workflow-queue-scheduler.ts";
import {
  enqueue,
  msUntilNextDue,
  QUEUE_DUE_SOON_MS,
  WORKFLOW_QUEUE_CHANNEL,
} from "./workflow-queue-store.ts";
import { type Delivered, WORKFLOW_QUEUE_INTERVAL_MS } from "./workflow-queue-sweep.ts";

captureLogs();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** The fragment that identifies the next-due read to a fake. */
const NEXT_DUE_KEY = "available_at > now()";

/** A recorder standing in for one reserved connection. */
function recorder(answer: (sql: string) => Record<string, unknown>[] = () => []) {
  const statements: string[] = [];
  return {
    statements,
    sql: async (text: string, _params?: unknown[]): Promise<Record<string, unknown>[]> => {
      statements.push(text);
      return answer(text);
    },
  };
}

describe("announce", () => {
  test("wakes a pass for a park DUE SOON, and stays silent for a long one", async () => {
    // The whole change in one case: the boundary is the delay, so it holds for a
    // `sleep()` and for a busy walk's re-park alike.
    for (const [delaySeconds, announced] of [
      [0, true],
      [QUEUE_DUE_SOON_MS / 1000, true],
      [(QUEUE_DUE_SOON_MS + 1) / 1000, false],
      [30, false],
    ] as const) {
      const rec = recorder((sql) => (sql.includes("insert into") ? [{ id: "m1" }] : []));
      await enqueue(rec.sql, {
        id: "m1",
        slug: "t1",
        queueName: "__wkf_workflow_r1",
        payload: {},
        delaySeconds,
      });
      const notified = rec.statements.some((sql) => sql.includes("pg_notify"));
      expect({ delaySeconds, notified }).toEqual({ delaySeconds, notified: announced });
    }
  });

  test("names the channel the sweep listens on", async () => {
    // Two modules must not spell it differently: a mismatch is silent, and its
    // only symptom is every hop paying the poll interval again.
    const rec = recorder((sql) => (sql.includes("insert into") ? [{ id: "m1" }] : []));
    await enqueue(rec.sql, { id: "m1", slug: "t1", queueName: "__wkf_workflow_r1", payload: {} });
    expect(WORKFLOW_QUEUE_CHANNEL).toBe("aai_workflow_queue");
    expect(rec.statements.some((sql) => sql.includes("pg_notify"))).toBe(true);
  });

  test("the ceiling IS the sweep's interval", async () => {
    // Declared in the store rather than imported from the sweep, because the
    // sweep imports the store and a constant both ends only read must not make a
    // cycle. The expression is identical, so configuration cannot separate them;
    // this is what stops an EDIT separating them.
    expect(QUEUE_DUE_SOON_MS).toBe(WORKFLOW_QUEUE_INTERVAL_MS);
  });
});

describe("msUntilNextDue", () => {
  test("answers the delay Postgres computed", async () => {
    const rec = recorder(() => [{ ms: "137" }]);
    expect(await msUntilNextDue(rec.sql)).toBe(137);
    // POSTGRES computes it, like every other timestamp arithmetic in this table:
    // a replica with a skewed clock must not schedule its extra look into
    // another replica's past.
    expect(rec.statements[0]).toContain("now()");
  });

  test("answers undefined for an empty queue, a junk row, and a row already due", async () => {
    // Three ways to have nothing to schedule a look FOR, and the caller's only
    // alternative to `undefined` would be to invent a delay.
    expect(await msUntilNextDue(recorder(() => []).sql)).toBeUndefined();
    expect(await msUntilNextDue(recorder(() => [{ ms: "soon" }]).sql)).toBeUndefined();
    expect(await msUntilNextDue(recorder(() => [{ ms: "0" }]).sql)).toBeUndefined();
  });

  test("reads only UNCLAIMED, FUTURE rows, which is what the partial index holds", async () => {
    // `workflow_queue_due_idx` is `(available_at) where locked_at is null`, so
    // this is an ordered index scan stopping at the first row rather than a
    // `min()` over the table — which is what makes it affordable once per pass.
    const rec = recorder(() => []);
    await msUntilNextDue(rec.sql);
    const sql = rec.statements[0] ?? "";
    expect(sql).toContain("locked_at is null");
    expect(sql).toContain(NEXT_DUE_KEY);
    expect(sql).toContain("limit 1");
  });
});

describe("the sweep arms one extra look", () => {
  /**
   * An `AdminDb` whose claim answers nothing and whose next-due read answers
   * `parked` once and nothing afterwards.
   *
   * ONCE, because that is what a real queue does: the read filters
   * `available_at > now()`, so the row stops matching the moment it is due —
   * which is also why a look cannot re-arm itself into a spin. A fake that kept
   * answering the same delay would assert a loop this code cannot enter.
   */
  function fakeDb(parked: number | undefined): {
    db: AdminDb;
    claims: () => number;
    notify: () => void;
  } {
    let claims = 0;
    let remaining = parked;
    const notifiers: (() => void)[] = [];
    const query = async <T>(sql: string): Promise<T[]> => {
      if (sql.includes("orchestration_due")) claims += 1;
      if (sql.includes(NEXT_DUE_KEY) && remaining !== undefined) {
        const ms = String(remaining);
        remaining = undefined;
        return [{ ms }] as T[];
      }
      return [] as T[];
    };
    return {
      claims: () => claims,
      notify: () => {
        for (const fire of notifiers) fire();
      },
      db: {
        reserve: () => Promise.resolve({ release: () => undefined, query }),
        listen: (_channel, onNotify) => {
          notifiers.push(onNotify);
          return Promise.resolve(() => undefined);
        },
      },
    };
  }

  const deliver = async (): Promise<Delivered> => ({ type: "completed" });

  test("claims again when the parked message becomes due, not at the next tick", async () => {
    // The measured shape: a run parks for 100 ms, `announce` wakes a pass, that
    // pass claims nothing because the row is not due — and arms a look for the
    // moment it is. Without the look this claim lands at the next tick, which is
    // up to a whole interval away whatever the sleep asked for.
    const fake = fakeDb(100);
    const stop = startWorkflowQueueSweep({ adminDb: fake.db, deliver, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);

    fake.notify();
    await vi.advanceTimersByTimeAsync(0);
    const afterNotify = fake.claims();
    expect(afterNotify).toBeGreaterThanOrEqual(1);

    // The park's own deadline, well short of the next tick.
    await vi.advanceTimersByTimeAsync(120);
    expect(fake.claims()).toBeGreaterThan(afterNotify);
    // And it is ONE extra look rather than a loop. The look cannot re-arm itself:
    // the read filters `available_at > now()`, so the row it was armed for stops
    // matching the moment it is due, and only a NEWLY parked message arms
    // another. What is left in the rest of this tick is nothing.
    const afterLook = fake.claims();
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.claims()).toBe(afterLook);
    stop();
  });

  test("arms NOTHING when the next park is further off than a tick", async () => {
    // Beyond one interval the ordinary tick gets there first, so a timer would be
    // a second mechanism for work the first one already covers.
    const fake = fakeDb(30_000);
    const stop = startWorkflowQueueSweep({ adminDb: fake.db, deliver, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    fake.notify();
    await vi.advanceTimersByTimeAsync(0);
    const afterNotify = fake.claims();

    // Most of a tick, during which only the armed look could have claimed.
    await vi.advanceTimersByTimeAsync(900);
    expect(fake.claims()).toBe(afterNotify);
    stop();
  });

  test("stopping the sweep cancels the pending look", async () => {
    // A timer outliving its sweep would reserve a connection on a replica that
    // has finished draining, which is the one thing a stop has to be able to
    // promise.
    const fake = fakeDb(500);
    const stop = startWorkflowQueueSweep({ adminDb: fake.db, deliver, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    fake.notify();
    await vi.advanceTimersByTimeAsync(0);
    const afterNotify = fake.claims();
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.claims()).toBe(afterNotify);
  });
});
