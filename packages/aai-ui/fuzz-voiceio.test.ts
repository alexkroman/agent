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
    const legitimate =
      entry.turn === null ||
      entry.ownStopDelivered ||
      entry.endedByHost ||
      !w.contextRunning() ||
      w.elapsed >= PLAYBACK_DONE_MAX_WAIT_MS;
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
  if (!node || turn === null) return;
  const deliver = (): void => {
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
  }, 120_000);
});
