// Copyright 2026 the AAI authors. MIT license.
/**
 * The three dedupers in `_memo.ts`, over interleavings nobody wrote by hand.
 *
 * All three share one shape — a caller either JOINS the build already
 * registered for its key or STARTS one — and differ only in retention:
 *
 * | flavor            | kept after success | kept after failure | invalidation      |
 * | ----------------- | ------------------ | ------------------ | ----------------- |
 * | `memoAsync`       | yes                | no                 | `reset()`         |
 * | `keyedMemoAsync`  | yes, per key       | no, per key        | `clear()` (all)   |
 * | `createSingleFlight` | no              | no                 | `drop(key)`       |
 *
 * so one model checks all three. The model is the build REGISTERED per key;
 * every call is checked against it at call time (did it start a build exactly
 * when nothing was registered?) and at the end (did it receive the outcome of
 * the build it joined?). Builds park on `fc.scheduler`, which decides the order
 * they settle in — and therefore whether a build settles while it still owns
 * its key, or after an invalidation handed the key to a successor.
 *
 * That last case is the one each module doc is careful about: a build's
 * settlement may only clear the registration it OWNS. A stale settlement that
 * clears a successor's costs a redundant rebuild (for `modal/harness-image.ts`,
 * a builder sandbox and a snapshot) — the model sees it as a call that started
 * a build while one was registered. `_memo.test.ts` pins the shrunk ordering
 * that found it in `memoAsync`.
 *
 * Nothing awaits a call: the quiesce is `s.waitIdle()` plus a microtask drain,
 * and outcomes are read off records, so a call left pending forever is a
 * counterexample rather than a suite timeout. No timers are involved.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { createSingleFlight, keyedMemoAsync, memoAsync } from "./_memo.ts";

/** Drain the microtask queue — only the dedupers' own hops can run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

type Flavor = "memoAsync" | "keyedMemoAsync" | "singleFlight";

type Op =
  | { k: "call"; key: number; fail: boolean }
  | { k: "invalidate"; key: number }
  | { k: "resume" };

const keyArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant(0) },
  { weight: 1, arbitrary: fc.constant(1) },
);

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 50,
    arbitrary: fc.record({
      k: fc.constant("call" as const),
      // Biased to one key: the stale-settlement state needs several ops on the
      // SAME key, and the second key is there only to show keys are independent.
      key: keyArb,
      fail: fc.boolean(),
    }),
  },
  {
    weight: 15,
    arbitrary: fc.record({ k: fc.constant("invalidate" as const), key: keyArb }),
  },
  { weight: 35, arbitrary: fc.record({ k: fc.constant("resume" as const) }) },
);

class BuildError extends Error {
  readonly gen: number;
  constructor(gen: number) {
    super(`build #${gen} failed`);
    this.gen = gen;
  }
}

type Reached = {
  /** Calls that joined a build still in flight. */
  joinedInFlight: number;
  /** Calls that started a build because the key's previous build had failed. */
  retriedAfterFailure: number;
  /** Builds that settled after an invalidation had registered a successor. */
  staleSettleOverSuccessor: number;
  /**
   * Calls that joined a successor AFTER an older build for its key failed late
   * — the state where an unowned clear would have started a redundant build.
   */
  joinedPastStaleFailure: number;
};

type Gen = { id: number; key: string; fail: boolean; settled: boolean };
type Call = { key: string; gen: number; outcome?: string };

/** The deduper under test, behind one call/invalidate surface. */
type Subject = {
  call(key: string, build: () => Promise<string>): Promise<string>;
  invalidate(key: string): void;
  /** Which keys an invalidation unregisters in the model. */
  invalidates(key: string, keys: readonly string[]): readonly string[];
  keepsSuccess: boolean;
  /** Live entries, where the deduper exposes a count. */
  size?: () => number;
};

function subjectFor(flavor: Flavor): Subject {
  if (flavor === "memoAsync") {
    // One memo, so one key: the build is fixed at construction and reads the
    // per-call builder through a slot.
    let next: () => Promise<string> = () => Promise.reject(new Error("unset"));
    const memo = memoAsync(() => next());
    return {
      call: (_key, build) => {
        next = build;
        return memo();
      },
      invalidate: () => memo.reset(),
      invalidates: (_key, keys) => keys,
      keepsSuccess: true,
    };
  }
  if (flavor === "keyedMemoAsync") {
    const memo = keyedMemoAsync<string>();
    return {
      call: (key, build) => memo(key, build),
      invalidate: () => memo.clear(),
      invalidates: (_key, keys) => keys,
      keepsSuccess: true,
    };
  }
  const flight = createSingleFlight<string>();
  return {
    call: (key, build) => flight.run(key, build),
    invalidate: (key) => flight.drop(key),
    invalidates: (key) => [key],
    keepsSuccess: false,
    size: () => flight.size(),
  };
}

/** One run's subject, model and observations. */
type Walk = {
  s: fc.Scheduler;
  subject: Subject;
  keys: readonly string[];
  reached: Reached;
  problems: string[];
  gens: Gen[];
  calls: Call[];
  /** The MODEL: the build each key's next caller must join, if any. */
  registered: Map<string, Gen>;
  /** Keys whose last settled build failed and nothing has rebuilt since. */
  failedLast: Set<string>;
  /** Per key, the successor an older build failed over, until a call joins it. */
  staleFailedOver: Map<string, Gen>;
};

/** Settle `gen` in the model — only the build that still OWNS its key unregisters it. */
function settleInModel(w: Walk, gen: Gen): void {
  gen.settled = true;
  const owner = w.registered.get(gen.key);
  if (owner === gen) {
    if (gen.fail || !w.subject.keepsSuccess) w.registered.delete(gen.key);
    if (gen.fail) w.failedLast.add(gen.key);
    return;
  }
  if (owner === undefined) return;
  w.reached.staleSettleOverSuccessor++;
  if (gen.fail) w.staleFailedOver.set(gen.key, owner);
}

/** A builder that parks on the scheduler, so the scheduler picks the settle order. */
const builder = (w: Walk, key: string, fail: boolean) => async (): Promise<string> => {
  const gen: Gen = { id: w.gens.length, key, fail, settled: false };
  w.gens.push(gen);
  await w.s.schedule(Promise.resolve(), `build ${key}#${gen.id}`);
  settleInModel(w, gen);
  if (fail) throw new BuildError(gen.id);
  return `#${gen.id}`;
};

/** A call must JOIN what is registered, and start a build only when nothing is. */
function joinedGen(w: Walk, step: number, key: string, started: number): Gen | undefined {
  const expected = w.registered.get(key);
  if (!expected) {
    if (started !== 1) {
      w.problems.push(`step ${step}: ${key} started ${started} builds with nothing registered`);
      return undefined;
    }
    const gen = w.gens.at(-1) as Gen;
    w.registered.set(key, gen);
    if (w.failedLast.delete(key)) w.reached.retriedAfterFailure++;
    return gen;
  }
  if (!expected.settled) w.reached.joinedInFlight++;
  if (w.staleFailedOver.get(key) === expected) {
    w.reached.joinedPastStaleFailure++;
    w.staleFailedOver.delete(key);
  }
  if (started === 0) return expected;
  w.problems.push(`step ${step}: ${key} started a build while #${expected.id} owned it`);
  return w.gens.at(-1);
}

function call(w: Walk, step: number, key: string, fail: boolean): void {
  const before = w.gens.length;
  const promise = w.subject.call(key, builder(w, key, fail));
  const gen = joinedGen(w, step, key, w.gens.length - before);
  const record: Call = { key, gen: gen?.id ?? -1 };
  w.calls.push(record);
  promise.then(
    (value) => {
      record.outcome = value;
    },
    (err: unknown) => {
      record.outcome = err instanceof BuildError ? `!#${err.gen}` : `!${String(err)}`;
    },
  );
}

async function apply(w: Walk, step: number, op: Op): Promise<void> {
  if (op.k === "resume") {
    if (w.s.count() > 0) await w.s.waitNext(1);
    return;
  }
  const key = w.keys[op.key % w.keys.length] as string;
  if (op.k === "call") {
    call(w, step, key, op.fail);
    return;
  }
  w.subject.invalidate(key);
  for (const k of w.subject.invalidates(key, w.keys)) w.registered.delete(k);
}

const outcomeOf = (gen: Gen | undefined): string => {
  if (!gen) return "?";
  return gen.fail ? `!#${gen.id}` : `#${gen.id}`;
};

/** Every call received the outcome of the build it joined, and nothing is left. */
function checkSettled(w: Walk): void {
  for (const [i, record] of w.calls.entries()) {
    const want = outcomeOf(w.gens[record.gen]);
    if (record.outcome !== want) {
      w.problems.push(`call ${i} (${record.key}) got ${String(record.outcome)}, expected ${want}`);
    }
  }
  const left = w.subject.size?.() ?? 0;
  if (left > 0) w.problems.push(`${left} entries never drained`);
}

async function runWalk(
  s: fc.Scheduler,
  flavor: Flavor,
  ops: readonly Op[],
  reached: Reached,
): Promise<string[]> {
  const w: Walk = {
    s,
    subject: subjectFor(flavor),
    keys: flavor === "memoAsync" ? ["a"] : ["a", "b"],
    reached,
    problems: [],
    gens: [],
    calls: [],
    registered: new Map(),
    failedLast: new Set(),
    staleFailedOver: new Map(),
  };
  for (const [step, op] of ops.entries()) {
    await apply(w, step, op);
    await settle();
    const size = w.subject.size?.() ?? w.registered.size;
    if (size !== w.registered.size) {
      w.problems.push(`step ${step}: size()=${size}, registered=${w.registered.size}`);
    }
  }
  await s.waitIdle();
  await settle();
  checkSettled(w);
  return w.problems;
}

/** Run the property for one flavor; throws the shrunk counterexample on failure. */
async function check(flavor: Flavor): Promise<Reached> {
  const reached: Reached = {
    joinedInFlight: 0,
    retriedAfterFailure: 0,
    staleSettleOverSuccessor: 0,
    joinedPastStaleFailure: 0,
  };
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc.array(opArb, { minLength: 1, maxLength: 30 }),
      async (s, ops) => {
        // Thrown rather than asserted: this runs outside a `test()` body, and
        // fast-check reports the message beside the shrunk counterexample.
        const problems = await runWalk(s, flavor, ops, reached);
        if (problems.length > 0) throw new Error(problems.join("\n"));
      },
    ),
    { numRuns: 1000 },
  );
  return reached;
}

describe("_memo dedupers under a generated interleaving", () => {
  // Floors sit under the OBSERVED MINIMUM over 20 `pnpm floors:sample` runs;
  // the `> 0` ones are on a state whose whole range is small.
  test("memoAsync: one build per generation, and a stale failure never evicts a successor", async () => {
    const reached = await check("memoAsync");
    expect(reached.joinedInFlight, "no call ever joined an in-flight build").toBeGreaterThan(800); // Measured over 20 runs: 1078-1192.
    expect(reached.retriedAfterFailure, "no call ever retried a failed build").toBeGreaterThan(180); // Measured over 20 runs: 242-276.
    expect(
      reached.staleSettleOverSuccessor,
      "no build ever settled after reset() registered a successor",
    ).toBeGreaterThan(60); // Measured over 20 runs: 83-126.
    expect(
      reached.joinedPastStaleFailure,
      "no call ever joined a successor after an older build failed over it",
    ).toBeGreaterThan(4); // Measured over 20 runs: 7-17.
  }, 30_000);

  test("keyedMemoAsync: one build per key and generation, settled by ownership", async () => {
    const reached = await check("keyedMemoAsync");
    expect(reached.joinedInFlight, "no call ever joined an in-flight build").toBeGreaterThan(600); // Measured over 20 runs: 825-1013.
    expect(reached.retriedAfterFailure, "no call ever retried a failed build").toBeGreaterThan(140); // Measured over 20 runs: 199-266.
    expect(
      reached.staleSettleOverSuccessor,
      "no build ever settled after clear() registered a successor",
    ).toBeGreaterThan(60); // Measured over 20 runs: 85-127.
    expect(
      reached.joinedPastStaleFailure,
      "no call ever joined a successor after an older build failed over it",
    ).toBeGreaterThan(0); // Measured over 20 runs: 1-12.
  }, 30_000);

  test("createSingleFlight: joins the window, retains nothing, and drains", async () => {
    const reached = await check("singleFlight");
    expect(reached.joinedInFlight, "no call ever joined an in-flight load").toBeGreaterThan(700); // Measured over 20 runs: 970-1154.
    expect(reached.retriedAfterFailure, "no call ever retried a failed load").toBeGreaterThan(170); // Measured over 20 runs: 235-283.
    expect(
      reached.staleSettleOverSuccessor,
      "no load ever settled after drop() registered a successor",
    ).toBeGreaterThan(25); // Measured over 20 runs: 38-72.
    expect(
      reached.joinedPastStaleFailure,
      "no call ever joined a successor after an older build failed over it",
    ).toBeGreaterThan(0); // Measured over 20 runs: 1-7.
  }, 30_000);
});
