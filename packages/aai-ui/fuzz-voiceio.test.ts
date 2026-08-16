// Copyright 2026 the AAI authors. MIT license.
/**
 * FUZZ HARNESS: randomized `VoiceIO` lifecycle interleavings — enqueue / done /
 * flush / close crossed with worklet 'stop' deliveries (immediate and lagged)
 * and context suspension. Invariants:
 *
 *  - L1 every `done()` promise settles, so a turn can never hang in "speaking".
 *  - L2 a `done()` promise settles only for a legitimate reason: the drain-stop
 *       for ITS OWN turn, a flush/close/newer `done()` that ended the turn, a
 *       context that stopped rendering, or the hard cap. Settling on an EARLIER
 *       turn's drain-stop reports the live reply finished while it is still
 *       speaking.
 *  - L3 `close()` is idempotent and never rejects.
 *
 * The simulated worklet mirrors the real one: it posts a drain-stop only after
 * a 'done' arrived, echoing that message's turn id, and delivery may lag the
 * host's own turn accounting by several operations.
 *
 * Driven by fast-check over a generated op script, so a failure shrinks to the
 * shortest sequence that still breaks an invariant. Every run tears its world
 * down in a `finally` — fake timers off, audio mocks restored — because
 * shrinking REPLAYS the property dozens of times: a run that threw while fake
 * timers were installed would hang the next replay's `createVoiceIO`, turning a
 * real counterexample into a timeout.
 */

import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installAudioMocks, type MockAudioWorkletNode, voiceOpts } from "./_react-test-utils.ts";
import { createVoiceIO, type VoiceIO } from "./audio.ts";
import { PLAYBACK_DONE_MAX_WAIT_MS } from "./types.ts";

function noop(): void {
  /* expected console output / unused callback */
}

const bytes = (samples: number) => new Uint8Array(samples * 2).buffer;

/** The turn id of the last 'done' the host posted — what the worklet echoes. */
function lastDoneTurn(node: MockAudioWorkletNode): number | null {
  const dones = node.port.posted.filter(
    (m): m is { event: "done"; turn: number } => (m as { event?: string }).event === "done",
  );
  return dones.at(-1)?.turn ?? null;
}

/**
 * One operation against the VoiceIO. Weights mirror the roll thresholds this
 * harness used before fast-check drove it.
 *
 * `drainStop.lag` is the number of operations the worklet's stop delivery
 * trails the host's own turn accounting by — `null` means it arrives at once.
 * A lagged stop crossing a later flush and the next turn's `done()` is the
 * in-flight-drain-stop race, so the lag is generated rather than fixed.
 */
type VoiceOp =
  | { kind: "enqueue"; samples: number }
  | { kind: "done" }
  | { kind: "flush" }
  | { kind: "drainStop"; lag: number | null }
  | { kind: "interruptStop" }
  | { kind: "suspendPlayback" };

const voiceOpArb: fc.Arbitrary<VoiceOp> = fc.oneof(
  {
    weight: 30,
    arbitrary: fc.record({
      kind: fc.constant("enqueue" as const),
      samples: fc.integer({ min: 4, max: 11 }),
    }),
  },
  { weight: 25, arbitrary: fc.record({ kind: fc.constant("done" as const) }) },
  { weight: 13, arbitrary: fc.record({ kind: fc.constant("flush" as const) }) },
  {
    weight: 18,
    arbitrary: fc.record({
      kind: fc.constant("drainStop" as const),
      lag: fc.option(fc.integer({ min: 2, max: 5 }), { nil: null }),
    }),
  },
  { weight: 7, arbitrary: fc.record({ kind: fc.constant("interruptStop" as const) }) },
  { weight: 7, arbitrary: fc.record({ kind: fc.constant("suspendPlayback" as const) }) },
);

type PendingDone = {
  turn: number | null;
  settled: boolean;
  /** A stop carrying this turn's id was delivered. */
  ownStopDelivered: boolean;
  /** flush()/close()/a newer done() ended this turn — settling it is by design. */
  endedByHost: boolean;
  promise: Promise<void>;
};

/**
 * States the generator must actually reach, asserted as floors after the run.
 *
 * fast-check has no coverage-floor mechanism (`fc.statistics` only prints), and
 * an all-green property proves nothing about a state the generator never
 * entered — see "Property tests run on fast-check" in the root guide.
 *
 * These are load-bearing rather than decorative, because L2's legitimacy check
 * short-circuits on `entry.turn === null`. If `playNode()` ever stopped
 * returning the node the host is driving, `lastDoneTurn()` would yield `null`,
 * EVERY settle would score as legitimate, L2 would assert nothing, and 200 runs
 * would report green. `postDrainStop` has the same escape, so the drain-stop
 * race could go unexercised in every run. A hard failure in `registerDone`
 * catches the case where the node is there and the turn id is not; these floors
 * catch the rest — a generator, a weight or a mock that stopped reaching the
 * state at all. *
 * Each floor sits under the OBSERVED MINIMUM across the runs recorded beside
 * it, not at a fixed fraction of the mean. These distributions have long left
 * tails — a counter averaging 38 was measured at 3 on one run — because what a
 * walk reaches is correlated within a run rather than independent per step, so
 * a floor placed under the mean flakes. The job of the floor is to catch a
 * state that is NEVER reached, not to pin how often; a state whose whole range
 * is small therefore gets `> 0`, which is still the assertion that matters.
 */
type Reached = {
  /** `done()` waits registered against a REAL turn id — the ones L2 can judge. */
  judgedDones: number;
  /**
   * Settles where the turn's OWN drain-stop was the only thing making them
   * legitimate: nothing ended the turn, the context was still rendering, and
   * the hard cap had not expired. This is the count L2 discriminates on.
   */
  ownStopSettles: number;
  /** Drain-stops the simulated worklet actually delivered. */
  drainStops: number;
  /** …of those, the ones whose delivery lagged across at least one later op. */
  laggedDrainStops: number;
};
const reached: Reached = { judgedDones: 0, ownStopSettles: 0, drainStops: 0, laggedDrainStops: 0 };

/** One run's world: the VoiceIO under test plus the bookkeeping L1/L2 need. */
type World = {
  io: VoiceIO;
  log: string[];
  pending: PendingDone[];
  violations: string[];
  /** Operations applied so far — the fuzz advances 1ms of fake time per op. */
  elapsed: number;
  playNode(): MockAudioWorkletNode | null;
  contextRunning(): boolean;
  /** Mark every pending wait as legitimately ended by the host. */
  endTurns(): void;
  /** Suspend the playback context, as a backgrounded tab does. */
  suspendPlayback(): void;
  restore(): void;
};

async function createWorld(): Promise<World> {
  // Fresh mocks per run: the mock registries accumulate, so a shared install
  // would leave this iteration driving a previous one's dead node.
  const audio = installAudioMocks();
  const warn = vi.spyOn(console, "warn").mockImplementation(noop);
  const io = await createVoiceIO(voiceOpts({ onError: noop }));
  const world: World = {
    io,
    log: [],
    pending: [],
    violations: [],
    elapsed: 0,
    playNode: () =>
      audio
        .workletNodes()
        .filter((n) => n.name === "playback-processor")
        .at(-1) ?? null,
    // The PLAYBACK context (created first, at the TTS rate) is the one done()'s
    // poll watches — the capture context is irrelevant to the drain.
    contextRunning: () => audio.contexts()[0]?.state === "running",
    suspendPlayback: () => {
      const ctx = audio.contexts()[0];
      if (ctx) ctx.state = "suspended";
    },
    endTurns: () => {
      for (const p of world.pending) p.endedByHost = true;
    },
    restore: () => {
      warn.mockRestore();
      audio.restore();
    },
  };
  return world;
}

/** Register a `done()` wait and the L2 legitimacy check for its settle. */
function registerDone(w: World): void {
  // A new done() replaces (and settles) the previous turn's waiter.
  w.endTurns();
  const promise = w.io.done();
  const node = w.playNode();
  const turn = node ? lastDoneTurn(node) : null;
  // A play node with no turn id on it HERE is a broken harness, not a quiet
  // pass: `done()` posts `{ event: "done", turn }` before returning whenever
  // the host holds a playback node, so this can only mean `playNode()` is not
  // returning the node the host is driving — the accumulating-mock-registry bug
  // this harness was already bitten by once. Unreported, it is exactly what
  // makes L2's `entry.turn === null` escape excuse every settle in every run.
  // (`postDrainStop`'s identical escape is legitimate per op — the simulated
  // worklet only stops a turn a 'done' named — so a floor guards that one.)
  if (node && turn === null) {
    w.violations.push("harness: done() left no turn id on the play node");
  }
  if (turn !== null) reached.judgedDones += 1;
  w.log.push(`done(turn=${turn})`);
  const entry: PendingDone = {
    turn,
    settled: false,
    ownStopDelivered: false,
    endedByHost: false,
    promise: Promise.resolve(),
  };
  entry.promise = promise.then(() => {
    entry.settled = true;
    const excused =
      entry.endedByHost || !w.contextRunning() || w.elapsed >= PLAYBACK_DONE_MAX_WAIT_MS;
    // The discriminating case: nothing else excuses this settle, so only the
    // turn's own drain-stop can make it legitimate.
    if (entry.turn !== null && entry.ownStopDelivered && !excused) reached.ownStopSettles += 1;
    const legitimate = entry.turn === null || entry.ownStopDelivered || excused;
    if (!legitimate) {
      w.violations.push(`done(turn=${entry.turn}) settled with no stop of its own`);
    }
  });
  w.pending.push(entry);
}

/** The worklet drained the turn its last 'done' named, and posts its stop. */
function postDrainStop(w: World, lag: number | null): void {
  const node = w.playNode();
  const turn = node ? lastDoneTurn(node) : null;
  // No 'done' yet means the worklet has no turn to drain — a legitimate no-op,
  // and the reason `reached.drainStops` carries a floor: taken on EVERY op it
  // would leave the drain-stop race unexercised in every run, silently.
  if (!node || turn === null) return;
  const postedAt = w.elapsed;
  const deliver = (): void => {
    reached.drainStops += 1;
    if (w.elapsed > postedAt) reached.laggedDrainStops += 1;
    for (const p of w.pending) if (p.turn === turn) p.ownStopDelivered = true;
    node.port.simulateMessage({ event: "stop", reason: "done", turn, stats: undefined });
  };
  if (lag === null) {
    w.log.push(`stop(done, turn=${turn}) delivered now`);
    deliver();
    return;
  }
  // Lagged delivery crosses later operations — a flush and the next turn's
  // done() — which is the in-flight-drain-stop race.
  w.log.push(`stop(done, turn=${turn}) delivery lagged ${lag} ops`);
  setTimeout(deliver, lag);
}

function postInterruptStop(w: World): void {
  const node = w.playNode();
  if (!node) return;
  w.log.push("stop(interrupt)");
  node.port.simulateMessage({
    event: "stop",
    reason: "interrupt",
    turn: lastDoneTurn(node),
    stats: undefined,
  });
}

async function applyOp(w: World, op: VoiceOp): Promise<void> {
  if (op.kind === "enqueue") {
    w.log.push("enqueue");
    w.io.enqueue(bytes(op.samples));
  } else if (op.kind === "done") {
    registerDone(w);
  } else if (op.kind === "flush") {
    w.log.push("flush");
    w.io.flush();
    w.endTurns();
  } else if (op.kind === "drainStop") {
    postDrainStop(w, op.lag);
  } else if (op.kind === "interruptStop") {
    postInterruptStop(w);
  } else {
    w.log.push("playback context suspended");
    w.suspendPlayback();
  }
  w.elapsed += 1;
  await vi.advanceTimersByTimeAsync(1);
}

/** Drive one op script; returns the invariant violations it produced. */
async function runVoiceIoScript(ops: readonly VoiceOp[]): Promise<string[]> {
  // Built on REAL timers: createVoiceIO awaits module loading, which is real
  // I/O that fake timers cannot pump.
  const w = await createWorld();
  vi.useFakeTimers();
  try {
    for (const op of ops) await applyOp(w, op);

    // L3: close twice — idempotent, never rejects. Reported through `problems`
    // rather than asserted here, so this helper stays assertion-free and every
    // violation reaches the property with the op log attached.
    w.endTurns();
    const problems: string[] = [];
    for (const attempt of [1, 2]) {
      const outcome = await w.io.close().then(
        (value) => (value === undefined ? null : `resolved with ${String(value)}`),
        (err: unknown) => `rejected with ${String(err)}`,
      );
      if (outcome) problems.push(`close() #${attempt} ${outcome}`);
    }

    // L1: every done() settles once the context is gone.
    w.elapsed += PLAYBACK_DONE_MAX_WAIT_MS + 1000;
    await vi.advanceTimersByTimeAsync(PLAYBACK_DONE_MAX_WAIT_MS + 1000);
    await Promise.all(w.pending.map((p) => p.promise));

    problems.push(...w.violations);
    const unsettled = w.pending.filter((p) => !p.settled).length;
    if (unsettled > 0) problems.push(`${unsettled} done() never settled`);
    return problems.map((problem) => `${problem}\n  ${w.log.join("\n  ")}`);
  } finally {
    // Order matters: fake timers must come off even when an assertion above
    // threw, or the next shrink replay's createVoiceIO never resolves.
    vi.useRealTimers();
    w.restore();
  }
}

describe("fuzz: VoiceIO lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles every done() and only for its own turn", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(voiceOpArb, { minLength: 1, maxLength: 30 }), async (ops) => {
        expect(await runVoiceIoScript(ops)).toEqual([]);
      }),
      { numRuns: 200 },
    );

    // Coverage floors — see `Reached` for how these are placed. Ranges are
    // over 22 runs of 200.
    expect(
      reached.judgedDones,
      "no done() was ever registered against a real turn",
    ).toBeGreaterThan(45); // 158-203
    expect(
      reached.ownStopSettles,
      "no settle was ever justified by its OWN drain-stop alone — L2 discriminated nothing",
      // The narrow one, and the low floor is deliberate. Reaching it needs a
      // drain-stop for the turn's OWN id to land while nothing else excuses the
      // settle — no flush/close/newer done(), context still rendering, cap not
      // expired — which a random 30-op walk produces a handful of times per
      // 200. Measured over 22 runs: 4-17, with a tail at 2 under coverage.
    ).toBeGreaterThan(0);
    expect(reached.drainStops, "the worklet never delivered a drain-stop").toBeGreaterThan(12); // 43-75
    expect(
      reached.laggedDrainStops,
      "no drain-stop delivery ever lagged across a later op — the in-flight race went unexercised",
    ).toBeGreaterThan(10); // 34-66
  }, 120_000);
});
