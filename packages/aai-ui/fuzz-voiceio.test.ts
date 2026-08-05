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
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { installAudioMocks, type MockAudioWorkletNode, voiceOpts } from "./_react-test-utils.ts";
import { createVoiceIO, type VoiceIO } from "./audio.ts";
import { PLAYBACK_DONE_MAX_WAIT_MS } from "./types.ts";

function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

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

type PendingDone = {
  turn: number | null;
  settled: boolean;
  /** A stop carrying this turn's id was delivered. */
  ownStopDelivered: boolean;
  /** flush()/close()/a newer done() ended this turn — settling it is by design. */
  endedByHost: boolean;
  promise: Promise<void>;
};

/** One seed's world: the VoiceIO under test plus the bookkeeping L1/L2 need. */
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

async function createWorld(seed: number): Promise<World> {
  // Fresh mocks per seed: the mock registries accumulate, so a shared install
  // would leave this iteration driving a previous one's dead node.
  const audio = installAudioMocks();
  const warn = vi.spyOn(console, "warn").mockImplementation(noop);
  const io = await createVoiceIO(voiceOpts({ onError: noop }));
  const world: World = {
    io,
    log: [`seed=${seed}`],
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
function postDrainStop(w: World, r: () => number): void {
  const node = w.playNode();
  const turn = node ? lastDoneTurn(node) : null;
  if (!node || turn === null) return;
  const deliver = (): void => {
    for (const p of w.pending) if (p.turn === turn) p.ownStopDelivered = true;
    node.port.simulateMessage({ event: "stop", reason: "done", turn, stats: undefined });
  };
  if (r() < 0.5) {
    w.log.push(`stop(done, turn=${turn}) delivered now`);
    deliver();
    return;
  }
  // Lagged delivery crosses later operations — a flush and the next turn's
  // done() — which is the in-flight-drain-stop race.
  const lag = 2 + Math.floor(r() * 4);
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

async function randomStep(w: World, r: () => number): Promise<void> {
  const roll = r();
  if (roll < 0.3) {
    w.log.push("enqueue");
    w.io.enqueue(bytes(4 + Math.floor(r() * 8)));
  } else if (roll < 0.55) {
    registerDone(w);
  } else if (roll < 0.68) {
    w.log.push("flush");
    w.io.flush();
    w.endTurns();
  } else if (roll < 0.86) {
    postDrainStop(w, r);
  } else if (roll < 0.93) {
    postInterruptStop(w);
  } else {
    w.log.push("playback context suspended");
    w.suspendPlayback();
  }
  w.elapsed += 1;
  await vi.advanceTimersByTimeAsync(1);
}

describe("fuzz: VoiceIO lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles every done() and only for its own turn", async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const w = await createWorld(seed);
      const r = rng(seed);
      vi.useFakeTimers();

      for (let step = 0; step < 30; step++) {
        await randomStep(w, r);
      }

      // L3: close twice — idempotent, never rejects.
      w.endTurns();
      await expect(w.io.close()).resolves.toBeUndefined();
      await expect(w.io.close()).resolves.toBeUndefined();

      // L1: every done() settles once the context is gone.
      w.elapsed += PLAYBACK_DONE_MAX_WAIT_MS + 1000;
      await vi.advanceTimersByTimeAsync(PLAYBACK_DONE_MAX_WAIT_MS + 1000);
      await Promise.all(w.pending.map((p) => p.promise));
      expect(
        w.pending.filter((p) => !p.settled),
        `seed ${seed}: unsettled done()\n  ${w.log.join("\n  ")}`,
      ).toEqual([]);
      expect(w.violations, `seed ${seed}: stale settle\n  ${w.log.join("\n  ")}`).toEqual([]);

      vi.useRealTimers();
      w.restore();
    }
  });
});
