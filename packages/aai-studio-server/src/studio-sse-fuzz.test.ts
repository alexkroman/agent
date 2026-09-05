// Copyright 2026 the AAI authors. MIT license.
/**
 * Randomized interleaving tests for the studio's SSE event streams and the
 * process-global live-stream registry behind them. Split from
 * `studio-concurrency-fuzz.test.ts` (which keeps the durable preview-deploy
 * queue) when that file hit the 700-line test cap: the two halves shared
 * nothing but fast-check, and every coverage floor lives in the file whose
 * property feeds it.
 *
 * Property tests, not scenario tests: fast-check builds a different
 * interleaving of pushes, disconnects and shutdowns on every run, then asserts
 * invariants that must hold for EVERY interleaving. The example-based suite
 * next door (`studio-sse.test.ts`) pins the specific orderings that once broke.
 *
 * ## `fc.scheduler` owns the async ordering
 *
 * Every await whose ordering matters — an SSE producer settling, a frame being
 * written — is registered with fast-check's scheduler, which decides the order
 * and, crucially, SHRINKS it. A failure reports the shortest op sequence and
 * the exact interleaving, as a `schedulerFor()` template that pastes straight
 * into a deterministic regression test.
 *
 * The invariants, and what each one being false looks like in production:
 *
 * - **No write after a stream ends.** A write into a response hono has closed
 *   is a chunked-body protocol error to whatever is reading (in production,
 *   Modal's ASGI proxy).
 * - **Frame order.** Frames are re-reads of a row; delivering an older one
 *   after a newer one leaves the client stale with no correction coming.
 * - **Exactly one cleanup, no registry leak.** The live-stream registry is
 *   process-global, so a leaked ender is called at shutdown for a response
 *   that already completed.
 */

import { sleep } from "@alexkroman1/aai/internal";
import {
  endLiveStreams,
  liveStreamCount,
  registerLiveStream,
  resetLiveStreams,
} from "aai-server/platform";
import fc from "fast-check";
import type { SSEMessage } from "hono/streaming";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createSsePusher, type SseStream } from "./studio-sse.ts";

beforeEach(() => resetLiveStreams());
afterEach(() => resetLiveStreams());

/** One operation against a live event stream. */
type SseOp =
  | { kind: "push" }
  | { kind: "rowVanished" }
  | { kind: "clientDisconnect" }
  | { kind: "scaleIn" }
  | { kind: "advanceScheduler" };

const sseOpArb: fc.Arbitrary<SseOp> = fc.oneof(
  { weight: 45, arbitrary: fc.record({ kind: fc.constant("push" as const) }) },
  { weight: 8, arbitrary: fc.record({ kind: fc.constant("rowVanished" as const) }) },
  { weight: 8, arbitrary: fc.record({ kind: fc.constant("clientDisconnect" as const) }) },
  { weight: 6, arbitrary: fc.record({ kind: fc.constant("scaleIn" as const) }) },
  // Heavily weighted, and the reason is `reachedSse`: a frame costs TWO
  // releases (its producer, then its write), so at the old 10 the walk pushed
  // far more than it ever delivered and the delivery invariants saw almost
  // nothing even once the releases started working.
  { weight: 33, arbitrary: fc.record({ kind: fc.constant("advanceScheduler" as const) }) },
);

/** The mutable bookkeeping one SSE interleaving accumulates. */
type SseWorld = {
  written: string[];
  queued: string[];
  ended: boolean;
  /** `writeSSE` entered after the stream ended — the invariant. */
  writesStartedAfterEnd: number;
  cleanups: number;
};

/**
 * States the SSE generator must actually reach, asserted as floors after the
 * run — same argument as `Reached` above, and this property is the reason the
 * rule is worth restating.
 *
 * Every delivery-side invariant below (no write after the end, frames in
 * order) is a statement about frames that were WRITTEN, and for a long time
 * none ever were: `sse.push` only CHAINS its producer, so the producer's
 * `s.schedule` call has not happened yet at the point the SYNCHRONOUS op loop
 * reads `s.count()`. It read 0 on every iteration, `advanceScheduler` never
 * released anything, the trailing `endNow` then closed the stream before a
 * single held task settled, and `createSsePusher`'s own `closed` guard skipped
 * every remaining write. Measured on the version this replaced: `writeSSE` was
 * called exactly ZERO times across 200 runs, while the suite reported green.
 *
 * `endsWhileWriting` is a reached STATE rather than a second invariant, and
 * the distinction is the module's: `write()` refuses to START a write once the
 * stream is closed, which is the whole of what it can promise. A write already
 * handed to `writeSSE` resolves whenever the runtime gets to it, and hono's
 * own stream rejects it if the response is gone (the pusher's `.catch` is
 * there for exactly that). So the close-during-an-in-flight-write interleaving
 * is not a failure — it is the ordering under which the invariants that DO
 * hold (end-exactly-once, no leak, nothing started after the end) are worth
 * checking, and a floor is what says the generator still produces it.
 */
const reachedSse = { framesWritten: 0, endsWhileWriting: 0, orderedPairs: 0 };

/**
 * One interleaving of an event stream's life: bursts of pushes whose producers
 * settle out of order, a client disconnect, a vanished row, and a shutdown
 * drain — in whatever order the generated op list picks.
 */
async function runSsePusher(s: fc.Scheduler, ops: readonly SseOp[]): Promise<string[]> {
  const problems: string[] = [];
  const w: SseWorld = {
    written: [],
    queued: [],
    ended: false,
    writesStartedAfterEnd: 0,
    cleanups: 0,
  };
  let onAbort = (): void => undefined;
  // `SseStream`, not `as unknown as SSEStreamingApi`: the pusher takes the two
  // methods it calls, so the fake implements the real contract and a change to
  // `writeSSE`'s signature is a compile error here rather than a laundered one.
  const stream: SseStream = {
    writeSSE: async (frame: SSEMessage) => {
      // Before the await: the invariant. `write()` must never hand a frame to
      // a stream that has ended — that is its `closed` guard, and this is the
      // only side of the await the module can be held to.
      if (w.ended) w.writesStartedAfterEnd += 1;
      await s.schedule(Promise.resolve(), `write ${String(frame.data)}`);
      // After it: a reached state, not a second invariant — see `reachedSse`.
      if (w.ended) reachedSse.endsWhileWriting += 1;
      reachedSse.framesWritten += 1;
      w.written.push(`${frame.event}:${frame.data}`);
    },
    onAbort: (callback: () => void) => {
      onAbort = callback;
    },
  };

  const sse = createSsePusher(stream);
  const held = sse.wait(() => {
    w.cleanups += 1;
  });
  // Mark the end at the instant it happens, not when the cleanup callback
  // later runs — a write started in between is a write into a closing response.
  const endNow = (end: () => void): void => {
    w.ended = true;
    end();
  };

  for (const [op, action] of ops.entries()) {
    if (action.kind === "push") {
      w.queued.push(`project:${op}`);
      sse.push(async () => {
        await s.schedule(Promise.resolve(), `produce ${op}`);
        return { event: "project", data: String(op) };
      });
    } else if (action.kind === "rowVanished") {
      // The watched row vanished (project deleted) — ends the stream.
      sse.push(async () => {
        w.ended = true;
        return null;
      });
    } else if (action.kind === "clientDisconnect") {
      endNow(onAbort);
    } else if (action.kind === "scaleIn") {
      endNow(endLiveStreams);
    } else {
      // Let one held producer or write settle mid-sequence. The microtask
      // yield is load-bearing, not tidiness: `sse.push` above only CHAINED the
      // producer, so nothing has called `s.schedule` yet at this point in the
      // synchronous loop and `s.count()` reads 0 — see `reachedSse`.
      await Promise.resolve();
      if (s.count() > 0) await s.waitNext(1);
    }
  }

  // Flush whatever the walk left held while the stream is still OPEN. The
  // forced end below is a shutdown drain, and `createSsePusher`'s `closed`
  // guard skips every write after it — so ending first leaves the delivery
  // invariants with nothing to look at in exactly the runs (most of them) that
  // generated no end of their own.
  if (!w.ended) await s.waitIdle();

  // A generated op list need not contain an end at all, and `held` only
  // resolves once the stream ends — so close it here when nothing else did.
  // A shutdown drain is a legitimate terminal event for any of these streams,
  // and it keeps the end-exactly-once invariant meaningful for every run.
  if (!w.ended) endNow(endLiveStreams);

  await s.waitFor(held);
  await s.waitIdle();
  // One real macrotask, through the SDK's own `sleep` (guard rules 4 and 19):
  // the pusher's cleanup runs in a `finally` behind `done.promise`.
  await sleep(0);
  return [...problems, ...checkSseOutcome(w)];
}

function checkSseOutcome(w: SseWorld): string[] {
  const problems: string[] = [];
  if (w.cleanups !== 1) problems.push(`cleanup ran ${w.cleanups} times`);
  if (w.writesStartedAfterEnd > 0) {
    problems.push(`${w.writesStartedAfterEnd} writes started into an ended stream`);
  }
  if (liveStreamCount() !== 0) problems.push("leaked a live-stream ender");
  // Delivered frames must be an in-order subsequence of what was pushed:
  // producers settle out of order, the chain does not.
  const positions = w.written
    .filter((frame) => frame.startsWith("project:"))
    .map((frame) => w.queued.indexOf(frame));
  // A run delivering fewer than two frames compares nothing, so the count of
  // comparisons — not of frames — is what says this invariant was exercised.
  reachedSse.orderedPairs += Math.max(0, positions.length - 1);
  for (let i = 1; i < positions.length; i += 1) {
    if ((positions[i] as number) <= (positions[i - 1] as number)) {
      problems.push(`frames out of order — ${w.written.join(", ")}`);
      break;
    }
  }
  return problems;
}

test("SSE pusher: no write survives the stream's end, and frames stay ordered", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc.array(sseOpArb, { minLength: 1, maxLength: 20 }),
      async (s, ops) => {
        resetLiveStreams();
        expect(await runSsePusher(s, ops)).toEqual([]);
      },
    ),
    { numRuns: 200 },
  );

  // Coverage floors — see `reachedSse`. Same rationale as the preview walk's:
  // set well below the measured actual, because a floor here exists to catch a
  // generator that stopped reaching a state, not to pin a count.
  expect(reachedSse.framesWritten, "not one frame was ever delivered").toBeGreaterThan(50); // ~190
  expect(
    reachedSse.orderedPairs,
    "no run ever delivered two frames, so nothing compared their order",
  ).toBeGreaterThan(15); // ~70
  expect(
    reachedSse.endsWhileWriting,
    "no run ever closed the response with a write in flight",
  ).toBeGreaterThan(3); // ~18
}, 120_000);

/**
 * The live-stream registry under arbitrary register/unregister/shutdown
 * interleavings. It is process-global and latches closed, so the two things
 * that can go wrong are a stale ender surviving its response and a stream
 * registered after the drain never being ended at all — the second is the
 * MODAL case, since the client's reconnect backoff is shorter than the
 * shutdown grace period.
 */
type RegistryOp = { kind: "register" } | { kind: "deregister"; which: number } | { kind: "drain" };

const registryOpArb: fc.Arbitrary<RegistryOp> = fc.oneof(
  { weight: 50, arbitrary: fc.record({ kind: fc.constant("register" as const) }) },
  {
    weight: 30,
    arbitrary: fc.record({
      kind: fc.constant("deregister" as const),
      which: fc.nat({ max: 1000 }),
    }),
  },
  { weight: 20, arbitrary: fc.record({ kind: fc.constant("drain" as const) }) },
);

/** Register a stream whose ends are counted; returns its deregistration. */
function registerCounting(counts: Map<number, number>, id: number, extra?: () => void): () => void {
  return registerLiveStream(() => {
    counts.set(id, (counts.get(id) ?? 0) + 1);
    extra?.();
  });
}

/**
 * Once drained, the registry latches closed — a stream opened afterwards must
 * end ITSELF rather than wait for a drain that already happened. Not the rare
 * case: the client's reconnect backoff is shorter than the shutdown grace
 * period, so a resubscribe landing here is the modal one.
 */
function endsItselfAfterShutdown(): boolean {
  let endedImmediately = false;
  registerCounting(new Map(), -1, () => {
    endedImmediately = true;
  });
  return endedImmediately;
}

/** One interleaving of registrations, deregistrations, and shutdown drains. */
function runLiveStreamRegistry(ops: readonly RegistryOp[]): string[] {
  const problems: string[] = [];
  const endCounts = new Map<number, number>();
  const open: (() => void)[] = [];
  let next = 0;
  let drained = false;

  for (const action of ops) {
    if (action.kind === "register") {
      open.push(registerCounting(endCounts, next++));
    } else if (action.kind === "deregister" && open.length > 0) {
      open.splice(action.which % open.length, 1)[0]?.();
    } else if (action.kind === "drain") {
      endLiveStreams();
      drained = true;
    }
  }

  if (drained && !endsItselfAfterShutdown()) {
    problems.push("a stream opened during shutdown was never ended");
  }
  for (const [id, count] of endCounts) {
    if (count > 1) problems.push(`stream ${id} ended ${count} times`);
  }
  for (const unregister of open) unregister();
  if (liveStreamCount() !== 0) problems.push(`leaked ${liveStreamCount()}`);
  return problems;
}

test("live-stream registry: end-once, self-end after shutdown, never leak", () => {
  fc.assert(
    fc.property(fc.array(registryOpArb, { minLength: 1, maxLength: 30 }), (ops) => {
      resetLiveStreams();
      expect(runLiveStreamRegistry(ops)).toEqual([]);
    }),
    { numRuns: 300 },
  );
});
