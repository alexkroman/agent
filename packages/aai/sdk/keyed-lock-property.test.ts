// Copyright 2026 the AAI authors. MIT license.
/**
 * The keyed lock's DEFINING property, over interleavings nobody wrote by hand.
 *
 * > Work submitted under one key runs one at a time in submission order, and
 * > work under different keys never blocks on each other.
 *
 * `keyed-lock.test.ts` next door states each of those on a hand-chosen
 * schedule — two holders of one key, one holder of another, one waiter that
 * gives up. This states them over a generated one, and it exists because the
 * failure mode of a concurrency test is not that it goes red: it is that the
 * schedule which breaks the invariant is the schedule nobody thought to write
 * down, and a test whose claim is a bare `await` HANGS to the suite timeout
 * rather than failing when it does.
 *
 * ## The model is a per-key FIFO queue
 *
 * `lock(key)` builds its place in the chain SYNCHRONOUSLY — it reads the tail
 * and claims a new one before returning a promise — so the model is exactly a
 * queue per key, ordered by call. Three claims follow, and each is checked from
 * OUTSIDE the lock, on observations any caller could make:
 *
 * - **Mutual exclusion**: at most one body is inside a key's section at a time.
 * - **FIFO**: the order bodies ENTER a key's section is the order their
 *   `lock(key)` calls were made, skipping only the acquirers that gave up.
 * - **Independence**: an acquire on a key with nothing outstanding enters after
 *   a microtask drain — while other keys are held by parked sections, so
 *   nothing but a cross-key dependency could stop it.
 *
 * ## `fc.scheduler` owns the interleaving
 *
 * Every critical section parks on `s.schedule` and the scheduler decides which
 * one resumes, so a failure reports the shortest op sequence AND the exact
 * interleaving, printed as a `schedulerFor()` template that pastes straight
 * into a deterministic regression test. The park is INSIDE the section body
 * rather than around the acquire (`s.schedule` in the body, not
 * `s.scheduleFunction` around `withLock`): the scheduler runs task bodies one
 * at a time to completion, so wrapping the acquire would serialize every
 * section and make mutual exclusion unfalsifiable — the harness would report
 * success by construction. Same reason as `studio-concurrency-fuzz.test.ts`,
 * whose module doc argues it.
 *
 * ## Nothing here awaits an acquire, and that is measured
 *
 * The quiesce is `s.waitIdle()` plus a microtask drain, and then every claim is
 * read off the MODEL. `await Promise.all(acquires)` is the obvious alternative
 * and it is the bare `await` this file exists to avoid: against a mutant that
 * drops the abandoning waiter's `resolve()` — the exact defect the second
 * property is aimed at — those promises stay pending forever, and the property
 * became a 60-second suite timeout naming nothing instead of a 34-millisecond
 * counterexample naming the wedged key. Every promise still gets its `.catch`
 * at submission, because an unhandled rejection is process-global state and a
 * leak converges the shrinker on the wrong counterexample.
 *
 * ## Two properties, because the deadline needs virtual time
 *
 * The first drives no timer at all. The second is about `timeoutMs`, i.e.
 * about a window elapsing, so it runs on fake timers — the repo rule is that a
 * spec observing a timer never observes the wall clock, and waiting out a real
 * second per op would make it a race besides. Its claim is the one the module
 * doc calls the property that makes a deadline safe rather than a new deadlock:
 * a waiter that walks away must resolve its place in the chain, or every later
 * acquirer for that key blocks forever.
 *
 * **An advance of exactly `timeoutMs` is not enough, and this is measured.**
 * Under fake timers a timer armed from INSIDE a tick is filed at `now + 1 +
 * delay` rather than `now + delay`, so an advance that matches the delay
 * exactly fires the timers armed outside a tick and silently never fires the
 * ones armed during one — which reads as the lock failing to time out. Every
 * advance here is `TIMEOUT_MS + 2`: one millisecond for that offset and one for
 * the strict comparison the timer wheel makes. Nothing is load-bearing about
 * the figure beyond it being past every outstanding deadline.
 */

import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";
import { createKeyedLock, type KeyedLock, KeyedLockTimeoutError, withLock } from "./keyed-lock.ts";

/** The keys a generated walk may use. Three, so two can be held at once. */
const KEYS = ["a", "b", "c"] as const;

/** The acquire deadline the second property drives. */
const TIMEOUT_MS = 1000;

/**
 * Drain the microtask queue.
 *
 * `flush()` in `aai/host/_test-utils.ts` is the repo's helper for this and is
 * unreachable here for the reason stated at the top of `keyed-lock.test.ts` —
 * it re-exports `sleep` while importing the whole host graph, and this is an
 * `sdk/` unit test.
 *
 * A FIXED count is sound where it would not be for the map-drain assertions
 * next door: nothing a parked section holds can settle without the scheduler
 * releasing it, so the only thing a drain can do is let the lock's own `.then`
 * hops run — a handful. A regression that made one key wait on another does not
 * resolve at ANY count, so raising this cannot turn a red run green.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/**
 * States the generated interleavings must have REACHED. An all-green property
 * proves nothing about a state the generator never entered, and the states here
 * are exactly the ones the claims are about — a walk with no contention
 * satisfies FIFO and mutual exclusion for free.
 *
 * Floors sit under the OBSERVED MINIMUM over 20 runs, with the range beside
 * each. Two more were measured and DROPPED rather than floored, each because
 * the floor beneath it cannot be reached without it, and a floor whose
 * information another already carries is the compliance floor
 * `check:property-floors` exists to discourage: plain contention (an acquire
 * landing on a busy key, measured 458-567 over the same runs, which
 * `queuedDeep` cannot rise without) and plain lapses (a deadline elapsing under
 * a waiter, measured 163-240, which `inheritedSlot` cannot rise without).
 */
const reached = {
  /** Acquires that landed THIRD or deeper in a key's queue. */
  queuedDeep: 0,
  /** Acquires that entered a free key WHILE another key was held. */
  crossKeyEntries: 0,
  /**
   * Acquires that entered a key behind an acquirer that had given up — the
   * "a timed-out waiter does not wedge the key" state, and the whole reason the
   * abandoning waiter resolves its own slot.
   */
  inheritedSlot: 0,
  /** Timed acquires that queued behind a holder and entered inside the deadline. */
  timedWaitedIn: 0,
};

/** One op of the FIFO walk. */
type WalkOp = { k: "acquire"; key: number } | { k: "resume" };

const walkOpArb: fc.Arbitrary<WalkOp> = fc.oneof(
  {
    weight: 70,
    arbitrary: fc.record({
      k: fc.constant("acquire" as const),
      key: fc.nat({ max: KEYS.length - 1 }),
    }),
  },
  { weight: 30, arbitrary: fc.record({ k: fc.constant("resume" as const) }) },
);

/** One op of the deadline walk. */
type DeadlineOp = { k: "acquire"; key: number; timed: boolean } | { k: "expire" } | { k: "resume" };

const deadlineOpArb: fc.Arbitrary<DeadlineOp> = fc.oneof(
  {
    weight: 52,
    arbitrary: fc.record({
      k: fc.constant("acquire" as const),
      key: fc.nat({ max: KEYS.length - 1 }),
      // Mostly timed: an untimed acquire cannot be abandoned, and abandonment
      // is what this property is about.
      timed: fc.oneof(
        { weight: 3, arbitrary: fc.constant(true) },
        { weight: 1, arbitrary: fc.constant(false) },
      ),
    }),
  },
  { weight: 24, arbitrary: fc.record({ k: fc.constant("expire" as const) }) },
  { weight: 24, arbitrary: fc.record({ k: fc.constant("resume" as const) }) },
);

/** Let one parked section resume, or fall through to a plain drain. */
async function resumeOne(s: fc.Scheduler): Promise<void> {
  if (s.count() > 0) await s.waitNext(1);
  else await settle();
}

/** Per-key bookkeeping, pre-seeded for every key so no read can miss. */
const perKey = <T>(make: () => T): Map<string, T> => new Map(KEYS.map((key) => [key, make()]));
const ids = (map: Map<string, number[]>, key: string): number[] => map.get(key) as number[];
const shift = (counts: Map<string, number>, key: string, by: number): void => {
  counts.set(key, (counts.get(key) as number) + by);
};

/** Everything both walks observe from outside the lock. */
type Ledger = {
  problems: string[];
  /** Ids that entered the section per key, in entry order. */
  entered: Map<string, number[]>;
  /** Submitted but not yet released or abandoned, per key. */
  outstanding: Map<string, number>;
  /** Which id is inside a key's section, if any. */
  inside: Map<string, number>;
};

const newLedger = (): Ledger => ({
  problems: [],
  entered: perKey<number[]>(() => []),
  outstanding: perKey(() => 0),
  // NOT pre-seeded: an absent entry is what "nobody is inside this key" means,
  // and it is what `holdSection` reads to detect a second occupant.
  inside: new Map<string, number>(),
});

/**
 * One critical section: record the entry, park on the scheduler, record the
 * exit. Mutual exclusion is checked at both ends — entering an occupied key,
 * and finding somebody else inside on the way out.
 */
async function holdSection(
  s: fc.Scheduler,
  ledger: Ledger,
  key: string,
  id: number,
): Promise<void> {
  const held = ledger.inside.get(key);
  if (held !== undefined) ledger.problems.push(`${key}: #${id} entered while #${held} held it`);
  ledger.inside.set(key, id);
  ids(ledger.entered, key).push(id);
  // The scheduler decides when this section ends — the interleaving under test.
  // Parked here rather than around the acquire; see the module doc.
  await s.schedule(Promise.resolve(), `hold ${key}#${id}`);
  const now = ledger.inside.get(key);
  if (now !== id) ledger.problems.push(`${key}: #${id} lost its section to #${String(now)}`);
  ledger.inside.delete(key);
  shift(ledger.outstanding, key, -1);
}

/**
 * INDEPENDENCE: a key with nothing outstanding owes no wait, whatever is held
 * elsewhere.
 *
 * Stated as "did it enter by the time the microtasks drained", never as "wait
 * until it does" — a lock that made keys block each other would leave that wait
 * pending for the life of the process.
 */
function checkIndependence(
  ledger: Ledger,
  key: string,
  id: number,
  heldElsewhere: readonly string[],
): void {
  if (ids(ledger.entered, key).includes(id)) {
    if (heldElsewhere.length > 0) reached.crossKeyEntries++;
    return;
  }
  const held = heldElsewhere.length > 0 ? heldElsewhere.join(",") : "nothing";
  ledger.problems.push(`${key}: #${id} did not enter a free key while ${held} was held`);
}

/** Nothing outstanding, and no entry left in the map. */
function checkDrained(ledger: Ledger, lock: KeyedLock): void {
  for (const key of KEYS) {
    const stuck = ledger.outstanding.get(key) as number;
    if (stuck > 0) {
      ledger.problems.push(`${key}: ${stuck} acquire(s) never ran — the key is wedged`);
    }
  }
  if (lock.size > 0) {
    ledger.problems.push(`the map kept ${lock.size} entr(y|ies) after every release`);
  }
}

/**
 * Walk the lock with no deadlines, checking mutual exclusion, FIFO and
 * independence. Returns everything that went wrong, so a counterexample prints
 * every violation rather than the first.
 */
async function runFifoWalk(s: fc.Scheduler, ops: readonly WalkOp[]): Promise<string[]> {
  const lock = createKeyedLock();
  const ledger = newLedger();
  /** The MODEL: ids submitted per key, in `lock(key)` call order. */
  const submitted = perKey<number[]>(() => []);
  let nextId = 0;

  const start = (key: string): number => {
    const id = nextId++;
    ids(submitted, key).push(id);
    shift(ledger.outstanding, key, 1);
    void withLock(lock, key, () => holdSection(s, ledger, key, id)).catch((err: unknown) => {
      ledger.problems.push(`${key}: #${id} rejected with ${String(err)}`);
    });
    return id;
  };

  for (const op of ops) {
    if (op.k === "resume") {
      await resumeOne(s);
      continue;
    }
    const key = KEYS[op.key] as string;
    const depth = ledger.outstanding.get(key) as number;
    // Captured before the acquire, and unchanged by the drain below: nothing a
    // parked section holds can settle without the scheduler.
    const heldElsewhere = [...ledger.inside.keys()].filter((other) => other !== key);
    const id = start(key);
    await settle();
    if (depth >= 2) reached.queuedDeep++;
    if (depth === 0) checkIndependence(ledger, key, id, heldElsewhere);
  }

  await s.waitIdle();
  await settle();

  for (const key of KEYS) {
    const want = ids(submitted, key).join(",");
    const got = ids(ledger.entered, key).join(",");
    if (got !== want) ledger.problems.push(`${key}: entered [${got}] for submissions [${want}]`);
  }
  checkDrained(ledger, lock);
  return ledger.problems;
}

/** One acquire of the deadline walk, as the model records it. */
type Attempt = {
  id: number;
  key: string;
  timed: boolean;
  /** Submitted onto a key that already had work outstanding. */
  queued: boolean;
  entered: boolean;
  abandoned: boolean;
};

/** Submit one acquire, timed or not, and record how it ends. */
function startAttempt(
  s: fc.Scheduler,
  lock: KeyedLock,
  ledger: Ledger,
  attempts: Attempt[],
  key: string,
  timed: boolean,
): void {
  const attempt: Attempt = {
    id: attempts.length,
    key,
    timed,
    queued: (ledger.outstanding.get(key) as number) > 0,
    entered: false,
    abandoned: false,
  };
  attempts.push(attempt);
  shift(ledger.outstanding, key, 1);
  const body = async (): Promise<void> => {
    attempt.entered = true;
    await holdSection(s, ledger, key, attempt.id);
  };
  const opts = timed ? { timeoutMs: TIMEOUT_MS } : undefined;
  void withLock(lock, key, body, opts).catch((err: unknown) => {
    shift(ledger.outstanding, key, -1);
    if (!(err instanceof KeyedLockTimeoutError)) {
      ledger.problems.push(`${key}: #${attempt.id} rejected with ${String(err)}`);
      return;
    }
    attempt.abandoned = true;
    if (attempt.entered) ledger.problems.push(`${key}: #${attempt.id} both entered and timed out`);
  });
}

/**
 * What must be true of every acquire that was still waiting when the clock
 * jumped past its deadline: a timed one gave up, an untimed one did not.
 *
 * An acquire that ENTERED during the advance is skipped — that could only
 * happen while a section is parked, which is a mutual-exclusion violation
 * `holdSection` reports, and it is not this check's finding.
 */
function checkLapsed(ledger: Ledger, waiting: readonly Attempt[]): void {
  for (const attempt of waiting) {
    if (attempt.entered) continue;
    if (attempt.timed && !attempt.abandoned) {
      ledger.problems.push(`${attempt.key}: #${attempt.id} outlived its ${TIMEOUT_MS}ms deadline`);
    }
    if (!attempt.timed && attempt.abandoned) {
      ledger.problems.push(`${attempt.key}: #${attempt.id} timed out with no deadline set`);
    }
  }
}

/**
 * LIVENESS, and the point of the whole property: on each key, everything that
 * did not give up eventually ran, in submission order. A waiter that walked
 * away without resolving its place leaves every id behind it here.
 */
function checkKeyLiveness(ledger: Ledger, key: string, mine: readonly Attempt[]): void {
  for (const attempt of mine) {
    if (attempt.entered || attempt.abandoned) continue;
    ledger.problems.push(
      `${key}: #${attempt.id} neither ran nor timed out — the key is wedged behind it`,
    );
  }
  const want = mine
    .filter((attempt) => !attempt.abandoned)
    .map((attempt) => attempt.id)
    .join(",");
  const got = ids(ledger.entered, key).join(",");
  if (got !== want) ledger.problems.push(`${key}: entered [${got}], expected [${want}]`);
}

/** Count the two states the deadline property's floors are on. */
function noteDeadlineCoverage(mine: readonly Attempt[]): void {
  let lapsed = false;
  for (const attempt of mine) {
    if (attempt.abandoned) lapsed = true;
    else if (lapsed && attempt.entered) reached.inheritedSlot++;
    if (attempt.timed && attempt.queued && attempt.entered) reached.timedWaitedIn++;
  }
}

/**
 * Walk the lock with deadlines, checking that an abandoned acquire never enters
 * and never wedges the key behind it.
 */
async function runDeadlineWalk(s: fc.Scheduler, ops: readonly DeadlineOp[]): Promise<string[]> {
  const lock = createKeyedLock();
  const ledger = newLedger();
  const attempts: Attempt[] = [];

  for (const op of ops) {
    if (op.k === "acquire") {
      startAttempt(s, lock, ledger, attempts, KEYS[op.key] as string, op.timed);
      // Drained here so the model is decided: an acquire on a free key has
      // entered by now, and one behind a parked section has not.
      await settle();
      continue;
    }
    if (op.k === "resume") {
      await resumeOne(s);
      continue;
    }
    const waiting = attempts.filter((attempt) => !(attempt.entered || attempt.abandoned));
    // Past every outstanding deadline — see the module doc on why `+ 2`.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 2);
    await settle();
    checkLapsed(ledger, waiting);
  }

  await s.waitIdle();
  await settle();

  for (const key of KEYS) {
    const mine = attempts.filter((attempt) => attempt.key === key);
    checkKeyLiveness(ledger, key, mine);
    noteDeadlineCoverage(mine);
  }
  if (lock.size > 0) {
    ledger.problems.push(`the map kept ${lock.size} entr(y|ies) after every release`);
  }
  return ledger.problems;
}

describe("createKeyedLock under a generated interleaving", () => {
  test("serializes one key in submission order and never blocks another", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(walkOpArb, { minLength: 1, maxLength: 30 }),
        async (s, ops) => {
          expect(await runFifoWalk(s, ops)).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );

    // Ranges over 20 runs, each floor set under the OBSERVED MINIMUM. Without
    // them the claims above are satisfied by walks in which no acquire ever
    // waited and no two keys were ever live at once.
    expect(reached.queuedDeep, "no acquire ever queued third or deeper").toBeGreaterThan(90); // 143-239
    expect(
      reached.crossKeyEntries,
      "no acquire ever entered a free key while another was held",
    ).toBeGreaterThan(220); // 336-405
  }, 60_000);

  test("a waiter that gives up on its deadline never enters, and wedges nobody", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(deadlineOpArb, { minLength: 1, maxLength: 26 }),
        async (s, ops) => {
          // Virtual time, per run, released whatever the run does — a leak here
          // does not merely flake, it converges the shrinker on the wrong
          // counterexample.
          vi.useFakeTimers();
          try {
            expect(await runDeadlineWalk(s, ops)).toEqual([]);
          } finally {
            vi.useRealTimers();
          }
        },
      ),
      { numRuns: 700 },
    );

    // Ranges over 20 runs, each floor set under the OBSERVED MINIMUM.
    expect(
      reached.inheritedSlot,
      "no acquire ever inherited an abandoned waiter's place in a chain",
    ).toBeGreaterThan(24); // 42-92
    expect(
      reached.timedWaitedIn,
      "no timed acquire ever waited and then entered inside its deadline",
    ).toBeGreaterThan(190); // 308-420
  }, 60_000);
});
