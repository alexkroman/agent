// Copyright 2026 the AAI authors. MIT license.
/**
 * Property test: the Soniox adapter's batched final racing its own flush
 * timer, the next utterance's frames, a far-end close or error, `close()` and
 * the session's abort.
 *
 * `soniox.test.ts` pins one ordering per case. Here a fake SERVER sits behind
 * the fake socket and `fc.scheduler` decides when each of its frames is put on
 * the wire and when each is delivered, while a generated client sends audio,
 * lets the 300 ms quiet window run (or not), closes, aborts, and has the far end
 * close or error. Frames arrive in order on one socket, as the real one's do —
 * the one thing the scheduler may NOT reorder.
 *
 * Every final token carries a unique tag, so attribution is checked directly.
 * The oracles are `SttEvents`' contract (`../openers.ts`) plus the adapter's
 * own batching rule:
 *
 * - **no loss, no duplication, in order**: the finals emitted, concatenated, are
 *   exactly the final tokens the adapter accepted — once the quiet window has
 *   run or `close()` has flushed the buffer, which is the liveness half;
 * - **no stale final**: a `partial` never fires while a final the adapter
 *   accepted BEFORE it is still unreported — that final would otherwise land
 *   in the next utterance's turn, after its first partial;
 * - **nothing after close**: no event once the socket has been dropped or
 *   `close()` has returned, and no `error` for a close the client initiated.
 *
 * Not an oracle: a buffered final that the quiet window flushes AFTER a
 * far-end close or error. The shell does not close on a stream error (the
 * transport terminates the session on it), so the timer is still armed; that
 * ordering is counted (`cov.finalAfterError`) and left unfloored, as it is a
 * contract question rather than a race the adapter loses.
 */

import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";
import { flush } from "../../_timing-test-utils.ts";
import type { CreateProviderSocket } from "../_socket.ts";
import type { SttSession } from "../openers.ts";
import { FakeWebSocket } from "../tts/_fake-ws-test-utils.ts";
import { openSoniox } from "./soniox.ts";

/** Longer than the adapter's 300 ms quiet window, so a tick of this lets it run. */
const QUIET_WINDOW_ELAPSED_MS = 400;

type FrameShape = "partial" | "mixed" | "allFinal" | "finished" | "empty" | "junk";

const frameShapeArb: fc.Arbitrary<FrameShape> = fc.oneof(
  { weight: 4, arbitrary: fc.constant("partial" as const) },
  { weight: 3, arbitrary: fc.constant("mixed" as const) },
  { weight: 3, arbitrary: fc.constant("allFinal" as const) },
  { weight: 1, arbitrary: fc.constant("finished" as const) },
  { weight: 1, arbitrary: fc.constant("empty" as const) },
  { weight: 1, arbitrary: fc.constant("junk" as const) },
);

type ActionKind = "audio" | "tick" | "close" | "abort" | "serverClose" | "serverError";

const actionArb: fc.Arbitrary<ActionKind> = fc.oneof(
  { weight: 3, arbitrary: fc.constant("audio" as const) },
  { weight: 5, arbitrary: fc.constant("tick" as const) },
  { weight: 1, arbitrary: fc.constant("close" as const) },
  { weight: 1, arbitrary: fc.constant("abort" as const) },
  { weight: 1, arbitrary: fc.constant("serverClose" as const) },
  { weight: 1, arbitrary: fc.constant("serverError" as const) },
);

const cov = {
  runs: 0,
  /** The quiet window flushed a buffered final on its own. */
  timerFlushes: 0,
  /** `close()` flushed a buffered final in its teardown. */
  closeFlushes: 0,
  /** A partial flushed the previous utterance's buffered final ahead of itself. */
  partialFlushes: 0,
  /** A frame landed while a final was buffered — the window the stale-final oracle is for. */
  framesWhileBuffered: 0,
  /** A far-end close or error with the session still open. */
  farEndFailures: 0,
  /** Unfloored: see the file doc. */
  finalAfterError: 0,
};

type Frame = { raw: string; finals: string };

/** The far end: frames synthesized but not yet sent, and frames on the wire. */
type Far = {
  s: fc.Scheduler;
  ws: FakeWebSocket | null;
  synth: Frame[];
  wire: Frame[];
};

let tagSeq = 0;

/** Each shape's server frame; a final token carries a unique `<utterance.n>` tag. */
const FRAMES: Record<FrameShape, (utterance: number, tag: () => string) => Frame> = {
  partial: (u) => ({
    raw: JSON.stringify({ tokens: [{ text: `~${u}~`, is_final: false }] }),
    finals: "",
  }),
  mixed: (u, tag) => {
    const f = tag();
    const tokens = [
      { text: f, is_final: true },
      { text: `~${u}~`, is_final: false },
    ];
    return { raw: JSON.stringify({ tokens }), finals: f };
  },
  allFinal: (_u, tag) => {
    const f = tag() + tag();
    return { raw: JSON.stringify({ tokens: [{ text: f, is_final: true }] }), finals: f };
  },
  finished: (_u, tag) => {
    const f = tag();
    return {
      raw: JSON.stringify({ tokens: [{ text: f, is_final: true }], finished: true }),
      finals: f,
    };
  },
  empty: () => ({ raw: JSON.stringify({ tokens: [] }), finals: "" }),
  junk: () => ({ raw: JSON.stringify({ tokens: 5 }), finals: "" }),
};

function buildFrame(shape: FrameShape, utterance: number): Frame {
  return FRAMES[shape](utterance, () => `<${utterance}.${++tagSeq}>`);
}

/** The client's model and the oracles over what the session emits. */
type Near = {
  violations: string[];
  session: SttSession;
  far: Far;
  controller: AbortController;
  /** Final token text the adapter accepted (delivered while it was listening). */
  accepted: string;
  /** Final text the session emitted, concatenated. */
  emitted: string;
  /** What the client is doing right now — attributes a final to its trigger. */
  phase: "idle" | "tick" | "close" | "deliver";
  /** A final fired inside the frame being delivered now. */
  finalThisFrame: boolean;
  /** Set once `close()` has returned: nothing may fire after. */
  closeReturned: boolean;
  /** The far end closed or errored — an `error` is owed, not a violation. */
  errorsAllowed: boolean;
  errored: boolean;
};

const flag = (near: Near, what: string): void => {
  near.violations.push(what);
};

/** Is the adapter still listening on its socket? `dropSocket` strips every listener. */
function listening(far: Far): boolean {
  return far.ws !== null && far.ws.listenerCount("message") > 0;
}

function checkLive(near: Near, event: string): void {
  if (near.closeReturned) flag(near, `${event} after close() returned`);
  else if (!listening(near.far) && near.phase !== "close") {
    flag(near, `${event} after the socket was dropped`);
  }
}

function deliver(near: Near): void {
  const far = near.far;
  const frame = far.wire.shift();
  if (frame === undefined || far.ws === null || far.ws.readyState !== FakeWebSocket.OPEN) return;
  if (listening(far)) {
    if (near.accepted.length > near.emitted.length) cov.framesWhileBuffered++;
    near.accepted += frame.finals;
  }
  near.phase = "deliver";
  near.finalThisFrame = false;
  try {
    far.ws.emit("message", Buffer.from(frame.raw));
  } finally {
    near.phase = "idle";
  }
}

function produce(near: Near): void {
  const frame = near.far.synth.shift();
  if (frame === undefined) return;
  near.far.wire.push(frame);
  void near.far.s.schedule(Promise.resolve(), "deliver").then(() => deliver(near));
}

function socketsFor(far: Far): CreateProviderSocket {
  return (url, options) => {
    const ws = new FakeWebSocket(url, options);
    far.ws = ws;
    return ws;
  };
}

function onFinal(near: Near, text: string): void {
  checkLive(near, `final ${JSON.stringify(text)}`);
  if (near.errored) cov.finalAfterError++;
  if (near.phase === "tick") cov.timerFlushes++;
  if (near.phase === "close") cov.closeFlushes++;
  if (near.phase === "deliver") near.finalThisFrame = true;
  near.emitted += text;
  if (!near.accepted.startsWith(near.emitted)) {
    flag(
      near,
      `finals ${JSON.stringify(near.emitted)} are not a prefix of ${JSON.stringify(near.accepted)}`,
    );
  }
}

function onPartial(near: Near, text: string): void {
  checkLive(near, `partial ${JSON.stringify(text)}`);
  if (near.emitted !== near.accepted) {
    flag(
      near,
      `partial ${JSON.stringify(text)} fired with final ${JSON.stringify(near.accepted.slice(near.emitted.length))} still unreported`,
    );
  } else if (near.finalThisFrame) {
    cov.partialFlushes++;
  }
}

async function closeSession(near: Near): Promise<void> {
  near.phase = "close";
  try {
    const closing = near.session.close();
    near.phase = "idle";
    await closing;
  } finally {
    near.phase = "idle";
  }
  near.closeReturned = true;
}

const ACTIONS: Record<ActionKind, (near: Near, tickMs: number) => Promise<void> | void> = {
  audio(near) {
    near.session.sendAudio(new Int16Array(160));
  },
  tick(near, tickMs) {
    near.phase = "tick";
    try {
      vi.advanceTimersByTime(tickMs);
    } finally {
      near.phase = "idle";
    }
  },
  close: (near) => closeSession(near),
  abort(near) {
    near.controller.abort();
  },
  serverClose(near) {
    const ws = near.far.ws;
    if (ws === null || ws.readyState !== FakeWebSocket.OPEN) return;
    if (listening(near.far)) cov.farEndFailures++;
    near.errorsAllowed = true;
    ws.close(1006);
  },
  serverError(near) {
    const ws = near.far.ws;
    if (ws === null || ws.readyState !== FakeWebSocket.OPEN) return;
    if (listening(near.far)) cov.farEndFailures++;
    near.errorsAllowed = true;
    ws.emit("error", new Error("far end failed"));
  },
};

async function openNear(far: Far, script: readonly FrameShape[][]): Promise<Near> {
  const controller = new AbortController();
  const session = await openSoniox({}, socketsFor(far)).open({
    sampleRate: 16_000,
    apiKey: "k",
    signal: controller.signal,
  });
  const near: Near = {
    violations: [],
    session,
    far,
    controller,
    accepted: "",
    emitted: "",
    phase: "idle",
    finalThisFrame: false,
    closeReturned: false,
    errorsAllowed: false,
    errored: false,
  };
  session.on("final", (text) => onFinal(near, text));
  session.on("partial", (text) => onPartial(near, text));
  session.on("error", () => {
    checkLive(near, "error");
    if (!near.errorsAllowed) flag(near, "stream error with the socket healthy");
    near.errored = true;
  });
  for (const [u, shapes] of script.entries()) {
    for (const shape of shapes) far.synth.push(buildFrame(shape, u + 1));
  }
  // One `produce` per synthesized frame; a frame cut later leaves its step a no-op.
  for (const _frame of far.synth) {
    void far.s.schedule(Promise.resolve(), "produce").then(() => produce(near));
  }
  return near;
}

/**
 * Liveness: let the quiet window run, then close. Every final the adapter
 * accepted must have been emitted exactly once, in order, by then.
 */
async function checkEveryFinalLands(near: Near, s: fc.Scheduler): Promise<void> {
  await s.waitIdle();
  if (!near.closeReturned && listening(near.far) && !near.errored) {
    vi.advanceTimersByTime(QUIET_WINDOW_ELAPSED_MS);
    if (near.emitted !== near.accepted) {
      flag(
        near,
        `the quiet window left ${JSON.stringify(near.accepted.slice(near.emitted.length))} unreported`,
      );
    }
  }
  if (!near.closeReturned) await closeSession(near);
  await flush();
  if (near.emitted !== near.accepted) {
    flag(
      near,
      `finals ${JSON.stringify(near.emitted)} !== accepted ${JSON.stringify(near.accepted)}`,
    );
  }
  vi.advanceTimersByTime(QUIET_WINDOW_ELAPSED_MS);
}

async function runOne(
  s: fc.Scheduler,
  script: readonly FrameShape[][],
  actions: readonly ActionKind[],
  ticks: readonly number[],
): Promise<string[]> {
  const far: Far = { s, ws: null, synth: [], wire: [] };
  const near = await openNear(far, script);
  try {
    const seq = s.scheduleSequence(
      actions.map((kind, i) => ({
        label: `${i}:${kind}`,
        builder: async () => ACTIONS[kind](near, ticks[i % ticks.length] ?? 0),
      })),
    );
    await s.waitFor(seq.task);
    await checkEveryFinalLands(near, s);
  } finally {
    await near.session.close();
    await s.waitIdle();
  }
  return near.violations;
}

describe("Soniox STT: the batched final racing its flush, the next utterance and close", () => {
  test("every accepted final is emitted once, in order, before the next partial, and nothing after close", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(fc.array(frameShapeArb, { minLength: 1, maxLength: 4 }), {
          minLength: 1,
          maxLength: 4,
        }),
        fc.array(actionArb, { minLength: 2, maxLength: 12 }),
        fc.array(fc.constantFrom(50, 150, 299, 300, QUIET_WINDOW_ELAPSED_MS), {
          minLength: 1,
          maxLength: 4,
        }),
        async (s, script, actions, ticks) => {
          cov.runs++;
          FakeWebSocket.reset();
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          try {
            const violations = await runOne(s, script, actions, ticks);
            expect(violations, `${violations.join("\n")}\n${String(s)}`).toEqual([]);
          } finally {
            vi.useRealTimers();
          }
        },
      ),
      { numRuns: 300 },
    );
    // Coverage floors, each under the observed minimum (`pnpm floors:sample
    // --runs 20`): an all-green property proves nothing about a state the
    // generator never reached.
    // Measured over 20 runs: 22-48.
    expect(cov.timerFlushes, "the quiet window never flushed a final").toBeGreaterThan(12);
    // Measured over 20 runs: 17-33.
    expect(cov.closeFlushes, "close() never flushed a buffered final").toBeGreaterThan(8);
    // Measured over 20 runs: 311-384.
    expect(cov.partialFlushes, "no partial flushed a buffered final").toBeGreaterThan(220);
    // Measured over 20 runs: 197-266.
    expect(cov.framesWhileBuffered, "no frame landed with a final buffered").toBeGreaterThan(140);
    // Measured over 20 runs: 134-169.
    expect(cov.farEndFailures, "the far end never failed mid-session").toBeGreaterThan(100);
    // `cov.finalAfterError` is deliberately unfloored: it counts a contract
    // question (see the file doc), not a state the oracles depend on.
  });
});
