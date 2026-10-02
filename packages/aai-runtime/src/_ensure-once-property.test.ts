// Copyright 2026 the AAI authors. MIT license.
/**
 * `ensureOnce`'s contract over generated interleavings of callers and settles.
 *
 * `_ensure-once.test.ts` next door pins each half on a hand-chosen schedule.
 * This walks a generated one, where the scheduler decides when each attempt
 * settles and the callers arrive between, and states the module doc as four
 * claims checked from outside:
 *
 * - **One at a time**: `run` is never entered while an earlier attempt is still
 *   in flight, and never again after one succeeded.
 * - **Join, don't restart**: a caller arriving while an attempt is in flight is
 *   handed THAT attempt's promise — the identical object — and starts nothing.
 * - **A failure is not remembered**: the next call after a rejection (async or a
 *   synchronous throw) starts a fresh attempt; nothing retries on its own.
 * - **Every caller sees its own attempt's result**: the same rejection object,
 *   or a resolve — and every caller settles.
 *
 * The case no hand-written test covers is a caller retrying FROM ITS OWN
 * REJECTION HANDLER. The memo is cleared by a `.catch` the helper attaches
 * before returning the promise, so it runs before any caller's handler; a
 * retry there must start a fresh attempt rather than re-join the dead one.
 * Clearing the memo any later (a `finally` chained onto the returned promise, a
 * `setTimeout`) passes every hand-written case and fails this.
 *
 * There is no abort to interleave: `ensureOnce` takes no signal, and its two
 * callers bound their own waits.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { ensureOnce } from "./_ensure-once.ts";

/** How one attempt of `run` ends. */
type Ending = "ok" | "fail" | "throw";

/** One op of the walk. */
type Op = { k: "call"; retry: boolean } | { k: "resume" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 60,
    arbitrary: fc.record({ k: fc.constant("call" as const), retry: fc.boolean() }),
  },
  { weight: 40, arbitrary: fc.record({ k: fc.constant("resume" as const) }) },
);

/**
 * How each attempt ends, consumed cyclically by attempt index — a SHORT list,
 * so a counterexample stays readable. Weighted against `ok`, since a success
 * ends the interesting part of the walk.
 */
const endingsArb = fc.array(
  fc.oneof(
    { weight: 2, arbitrary: fc.constant<Ending>("ok") },
    { weight: 3, arbitrary: fc.constant<Ending>("fail") },
    { weight: 1, arbitrary: fc.constant<Ending>("throw") },
  ),
  { minLength: 1, maxLength: 6 },
);

/** Drain the microtask queue. Nothing parked on the scheduler can settle here. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/**
 * States the walks must have REACHED. Floors sit under the OBSERVED MINIMUM
 * over 20 runs (`pnpm floors:sample --runs 20`), with the range beside each.
 */
const reached = {
  /** Callers that arrived while an attempt was in flight and joined it. */
  joined: 0,
  /** Fresh attempts started by the call after an asynchronous rejection. */
  freshAfterFail: 0,
  /** Fresh attempts started by the call after a synchronous throw. */
  freshAfterThrow: 0,
  /** Retries made from a caller's own rejection handler that started a fresh attempt. */
  handlerRetries: 0,
  /** Calls made after a success, which must start nothing. */
  afterDone: 0,
};

type Attempt = { ending: Ending; error: Error; promise?: Promise<void> };
type Caller = { attempt: number | undefined; result: "pending" | "ok" | unknown };
type State = { k: "idle" } | { k: "inflight"; attempt: number } | { k: "done" };

async function runWalk(
  s: fc.Scheduler,
  ops: readonly Op[],
  endings: readonly Ending[],
): Promise<string[]> {
  const problems: string[] = [];
  const attempts: Attempt[] = [];
  const callers: Caller[] = [];
  let state: State = { k: "idle" };
  let inflight = 0;

  const ensure = ensureOnce(() => {
    const index = attempts.length;
    const ending = endings[index % endings.length] as Ending;
    const attempt: Attempt = { ending, error: new Error(`attempt #${index}`) };
    attempts.push(attempt);
    if (state.k === "done") problems.push(`attempt #${index} ran after a success`);
    if (inflight > 0) problems.push(`attempt #${index} ran while another was in flight`);
    // In flight until its rejection CLEARS the memo — see `call` for when that is.
    state = { k: "inflight", attempt: index };
    if (ending === "throw") throw attempt.error;
    inflight++;
    // The scheduler decides when this attempt settles — the interleaving under test.
    return s.schedule(Promise.resolve(), `run#${index}`).then(() => {
      inflight--;
      if (ending !== "ok") throw attempt.error;
      state = { k: "done" };
    });
  });

  /** A call on an idle memo: it must start exactly one attempt. */
  const fresh = (promise: Promise<void>, before: number, fromHandler: boolean): number => {
    const started = attempts.length - before;
    if (started !== 1) problems.push(`a call on an idle memo started ${started} attempts`);
    const attempt = attempts[before];
    if (attempt) attempt.promise = promise;
    // The model goes idle here: the first handler attached after `ensure()`
    // returns, so after the helper's own clearing `.catch` and before any
    // caller's handler. A retry from a caller's handler must therefore start
    // fresh; one from a handler that ran EARLIER would legitimately join.
    promise.catch(() => {
      if (state.k === "inflight" && state.attempt === before) state = { k: "idle" };
    });
    const previous = attempts[before - 1];
    if (previous?.ending === "fail") reached.freshAfterFail++;
    if (previous?.ending === "throw") reached.freshAfterThrow++;
    if (fromHandler) reached.handlerRetries++;
    return before;
  };

  /** A call while `joined` is in flight: the same promise, and nothing started. */
  const join = (promise: Promise<void>, before: number, joined: number): number => {
    if (attempts.length !== before) problems.push(`a call joining #${joined} started an attempt`);
    if (promise !== attempts[joined]?.promise) {
      problems.push(`a call joining #${joined} got a different promise`);
    }
    reached.joined++;
    return joined;
  };

  const call = (retry: boolean, fromHandler: boolean): void => {
    const before = attempts.length;
    const prior = state;
    // `ensure()` never throws synchronously (its `run` is called inside an async
    // wrapper); if it ever did, the property fails with that throw.
    const promise = ensure();
    const caller: Caller = { attempt: undefined, result: "pending" };
    if (prior.k === "idle") caller.attempt = fresh(promise, before, fromHandler);
    else if (prior.k === "inflight") caller.attempt = join(promise, before, prior.attempt);
    else {
      if (attempts.length !== before) problems.push("a call after a success started an attempt");
      reached.afterDone++;
    }
    callers.push(caller);
    promise.then(
      () => {
        caller.result = "ok";
      },
      (err: unknown) => {
        caller.result = err;
        if (retry) call(false, true);
      },
    );
  };

  for (const op of ops) {
    if (op.k === "call") call(op.retry, false);
    else if (s.count() > 0) await s.waitOne();
    await settle();
  }
  await s.waitIdle();
  await settle();

  if (inflight !== 0) problems.push(`${inflight} attempt(s) never settled`);
  callers.forEach((caller, i) => {
    const attempt = caller.attempt === undefined ? undefined : attempts[caller.attempt];
    const want = attempt === undefined || attempt.ending === "ok" ? "ok" : attempt.error;
    if (caller.result !== want) {
      problems.push(
        `caller ${i} (attempt #${caller.attempt}) saw ${String(caller.result)}, want ${String(want)}`,
      );
    }
  });
  return problems;
}

describe("ensureOnce under a generated interleaving", () => {
  test("one attempt at a time, joined by concurrent callers, retried on the next call after a failure", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(opArb, { minLength: 1, maxLength: 24 }),
        endingsArb,
        async (s, ops, endings) => {
          expect(await runWalk(s, ops, endings)).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );

    // Ranges over 20 runs, each floor under the OBSERVED MINIMUM.
    expect(reached.joined, "no caller ever joined an in-flight attempt").toBeGreaterThan(300); // 448-663
    expect(reached.freshAfterFail, "no call ever retried after a rejection").toBeGreaterThan(140); // 204-256
    expect(reached.freshAfterThrow, "no call ever retried after a sync throw").toBeGreaterThan(50); // 77-140
    expect(
      reached.handlerRetries,
      "no rejection handler's retry ever started a fresh attempt",
    ).toBeGreaterThan(120); // 181-230
    expect(reached.afterDone, "no call ever arrived after a success").toBeGreaterThan(130); // 190-288
  });
});
