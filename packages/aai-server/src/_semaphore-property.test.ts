// Copyright 2026 the AAI authors. MIT license.
/**
 * The semaphore's defining properties, over interleavings nobody wrote by hand.
 *
 * `_semaphore.test.ts` next door states each claim on one hand-picked
 * schedule. This walks a generated one — acquires, deadlines lapsing, holders
 * finishing in an order `fc.scheduler` picks — and checks, from OUTSIDE the
 * semaphore after every step:
 *
 * - **Bounded**: `active` is never above the limit nor below zero, and equals
 *   the number of slots handed out and not yet released.
 * - **No idle slot while someone waits**: a caller is queued only while every
 *   slot is held — a release that failed to hand off would leave a waiter
 *   parked beside a free slot (a lost wake-up).
 * - **FIFO**: slots are granted in `acquire()` call order, skipping only the
 *   callers whose deadline lapsed.
 * - **Deadlines**: a waiter still queued when the clock jumps past its deadline
 *   resolves null, never ALSO receives a slot, and is dropped from the queue.
 * - **Liveness**: once every holder finishes, every caller was either granted
 *   or timed out, and the pool is back to empty.
 * - **Idempotent release**: some holders release twice; the second must free
 *   nothing.
 *
 * There is no release-on-throw or abort claim to make: the module exposes no
 * wrapper that runs caller code (callers `try/finally` the release themselves)
 * and no `AbortSignal` — the bounded wait IS its cancellation, and that is the
 * deadline claim above.
 *
 * Holders park INSIDE the slot on `s.schedule`, so the scheduler decides which
 * holder finishes next; wrapping the acquire instead would serialize every
 * holder and make the bound unfalsifiable (see `keyed-lock-property.test.ts`
 * in `aai`, whose shape this follows). Nothing awaits an acquire: the quiesce is
 * `s.waitIdle()` plus a microtask drain, and every claim is read off the
 * model, so a wedged waiter is a counterexample rather than a suite timeout.
 *
 * Deadlines run on fake timers, per run, restored in a `finally`. Every advance
 * is `TIMEOUT_MS + 2` for the reason that file's module doc measures: a timer
 * armed inside a tick is filed one millisecond late.
 */

import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";
import { createSemaphore, type Semaphore } from "./_semaphore.ts";

const TIMEOUT_MS = 1000;

/** Drain the microtask queue — only the semaphore's own hops can run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** States the walks must have reached; floors are asserted after the property. */
const reached = {
  /** Callers that queued behind a full pool and were later granted a slot. */
  queuedThenGranted: 0,
  /** Callers granted a slot AFTER an earlier caller's deadline lapsed in the queue. */
  grantedPastLapse: 0,
  /** Double releases made while another caller was queued. */
  doubleReleaseContended: 0,
};

type Op = { k: "acquire"; double: boolean } | { k: "expire" } | { k: "resume" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 50,
    arbitrary: fc.record({
      k: fc.constant("acquire" as const),
      double: fc.oneof(
        { weight: 3, arbitrary: fc.constant(false) },
        { weight: 1, arbitrary: fc.constant(true) },
      ),
    }),
  },
  { weight: 20, arbitrary: fc.record({ k: fc.constant("expire" as const) }) },
  { weight: 30, arbitrary: fc.record({ k: fc.constant("resume" as const) }) },
);

type Attempt = {
  id: number;
  double: boolean;
  queued: boolean;
  granted: boolean;
  lapsed: boolean;
  released: boolean;
};

type World = {
  sem: Semaphore;
  limit: number;
  attempts: Attempt[];
  grants: number[];
  problems: string[];
};

const holding = (w: World): number => w.attempts.filter((a) => a.granted && !a.released).length;
const pending = (w: World): Attempt[] => w.attempts.filter((a) => !(a.granted || a.lapsed));

/** One caller: acquire, park inside the slot until the scheduler lets it go, release. */
function start(s: fc.Scheduler, w: World, double: boolean): Attempt {
  const attempt: Attempt = {
    id: w.attempts.length,
    double,
    queued: w.sem.active >= w.limit,
    granted: false,
    lapsed: false,
    released: false,
  };
  w.attempts.push(attempt);
  const contended = (): boolean => pending(w).length > 0;
  void w.sem
    .acquire(TIMEOUT_MS)
    .then(async (release) => {
      if (release === null) {
        attempt.lapsed = true;
        return;
      }
      if (attempt.lapsed) w.problems.push(`#${attempt.id} both timed out and was granted`);
      attempt.granted = true;
      w.grants.push(attempt.id);
      if (holding(w) > w.limit) w.problems.push(`#${attempt.id} made ${holding(w)} holders`);
      await s.schedule(Promise.resolve(), `hold #${attempt.id}`);
      attempt.released = true;
      release();
      if (attempt.double) {
        if (contended()) reached.doubleReleaseContended++;
        release();
      }
    })
    .catch((err: unknown) => {
      w.problems.push(`#${attempt.id} rejected with ${String(err)}`);
    });
  return attempt;
}

/** The counters the semaphore exposes must agree with the model at every quiet point. */
function checkCounters(w: World, at: string): void {
  const { active, waiting } = w.sem;
  if (active < 0 || active > w.limit) w.problems.push(`${at}: active=${active} of ${w.limit}`);
  if (active !== holding(w)) w.problems.push(`${at}: active=${active}, holders=${holding(w)}`);
  if (waiting !== pending(w).length) {
    w.problems.push(`${at}: waiting=${waiting}, queued callers=${pending(w).length}`);
  }
  if (waiting > 0 && active < w.limit) {
    w.problems.push(`${at}: ${waiting} waiting beside a free slot (active=${active})`);
  }
}

/** Apply one op and check what it alone promises. */
async function apply(s: fc.Scheduler, w: World, op: Op): Promise<void> {
  if (op.k === "acquire") {
    const free = w.sem.active < w.limit;
    const attempt = start(s, w, op.double);
    await settle();
    if (free && !attempt.granted) w.problems.push(`#${attempt.id} waited with a slot free`);
    return;
  }
  if (op.k === "resume") {
    if (s.count() > 0) await s.waitNext(1);
    await settle();
    return;
  }
  const waiting = pending(w);
  await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 2);
  await settle();
  for (const a of waiting) {
    if (!a.lapsed) w.problems.push(`#${a.id} outlived its ${TIMEOUT_MS}ms deadline`);
  }
}

/** LIVENESS and FIFO, once every holder has finished. */
function checkDrained(w: World): void {
  for (const a of w.attempts) {
    if (!(a.granted || a.lapsed)) w.problems.push(`#${a.id} neither granted nor timed out`);
    if (a.granted && !a.released) w.problems.push(`#${a.id} never released`);
  }
  const want = w.attempts.filter((a) => !a.lapsed).map((a) => a.id);
  if (w.grants.join(",") !== want.join(",")) {
    w.problems.push(`granted [${w.grants.join(",")}], expected FIFO [${want.join(",")}]`);
  }
  if (w.sem.active !== 0 || w.sem.waiting !== 0) {
    w.problems.push(`drained to active=${w.sem.active}, waiting=${w.sem.waiting}`);
  }
}

function noteCoverage(w: World): void {
  let lapsedBefore = false;
  for (const a of w.attempts) {
    if (!a.queued) continue;
    if (a.lapsed) lapsedBefore = true;
    else if (a.granted) {
      reached.queuedThenGranted++;
      if (lapsedBefore) reached.grantedPastLapse++;
    }
  }
}

async function runWalk(s: fc.Scheduler, limit: number, ops: readonly Op[]): Promise<string[]> {
  const w: World = { sem: createSemaphore(limit), limit, attempts: [], grants: [], problems: [] };
  for (const [step, op] of ops.entries()) {
    await apply(s, w, op);
    checkCounters(w, `step ${step} (${op.k})`);
  }
  await s.waitIdle();
  await settle();
  checkDrained(w);
  noteCoverage(w);
  return w.problems;
}

describe("createSemaphore under a generated interleaving", () => {
  test("bounds holders, grants FIFO, honours deadlines and never wedges", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.integer({ min: 1, max: 3 }),
        fc.array(opArb, { minLength: 1, maxLength: 30 }),
        async (s, limit, ops) => {
          vi.useFakeTimers();
          try {
            expect(await runWalk(s, limit, ops)).toEqual([]);
          } finally {
            vi.useRealTimers();
          }
        },
      ),
      { numRuns: 300 },
    );

    // Ranges over 20 runs, each floor set under the OBSERVED MINIMUM.
    expect(reached.queuedThenGranted, "no caller ever queued and was then granted").toBeGreaterThan(
      150,
    ); // Measured over 20 runs: 201-271.
    expect(
      reached.grantedPastLapse,
      "no caller was ever granted past a lapsed waiter",
    ).toBeGreaterThan(20); // Measured over 20 runs: 32-67.
    expect(
      reached.doubleReleaseContended,
      "no double release ever happened while a caller was queued",
    ).toBeGreaterThan(25); // Measured over 20 runs: 40-71.
  }, 30_000);
});
