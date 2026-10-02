// Copyright 2026 the AAI authors. MIT license.
/**
 * Randomized interleavings of coding-agent turns through the turn gate and
 * `deliverTurn`: model chunks released in an order `fc.scheduler` picks, the
 * model failing mid-stream, the browser closing a response mid-stream, and a
 * new turn arriving before the previous one has settled.
 *
 * What is REAL: the AI SDK (`streamText`, `toUIMessageStream`, its SSE pipe),
 * `withStreamErrorChunk`, `deliverTurn` and `createTurnGate`. What is faked:
 * the provider (a `MockLanguageModelV3` whose every part waits on the
 * scheduler, and which errors its stream on abort as a real gateway fetch
 * does) and the `ServerResponse` — an emitter that, like Node's, emits `close`
 * when the client goes away and answers every later `write` with `false`.
 *
 * The wiring around them mirrors `handleStudioRequest`/`runTurn` in
 * `chat.ts`: abort on a close before the response ended, and release the gate
 * on close OR on the turn settling. That function needs the whole agent and a
 * workspace (it is scenario-tier), so the wiring is restated here in the
 * dozen lines it takes, against the same exported pieces.
 *
 * The invariants:
 *
 * - **Every admitted turn settles exactly once** (`onFinish`, which is what
 *   runs `settleTurn`) — on a finish, a model failure and a client close alike.
 * - **A turn is refused only while another holds the gate**, and **two
 *   responses are never streaming at once**.
 * - **No frame is attributed to the wrong turn**: each response carries only
 *   its own model's deltas, in order.
 * - **An `error` frame is the last frame**, sent only for a model failure.
 * - **A turn whose client stayed connected resolves `deliverTurn`.**
 *
 * Deliberately NOT asserted: that `deliverTurn` resolves after the client
 * closed mid-stream. It does not. The AI SDK's `writeToServerResponse` awaits
 * `drain` after a `write` returns `false`, and a destroyed response never
 * emits `drain` (verified against a real `http` server) — so the pipe, and
 * with it `deliverTurn`, stays pending forever. The turn still SETTLES (the
 * short tail after an abort fits in the stream queues, so `onFinish` runs —
 * asserted above), so what leaks is a pending promise and its operator-side
 * failure log, not the settle. Reported rather than fixed here: the hang is in
 * the SDK's writer.
 */

import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { sleep } from "@alexkroman1/aai/internal";
import { streamText, type UIMessageChunk } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import fc from "fast-check";
import { expect, test } from "vitest";
import { createTurnGate, deliverTurn } from "./turn-stream.ts";

/** How one turn's model behaves: N deltas, then a finish or a failure. */
type Script = { deltas: number; fails: boolean };

/** One event in the world. */
type Op =
  /**
   * A new turn. `queued`: the tab's composer holds it and dispatches the
   * moment it sees the current stream END — synchronously from the close,
   * which is the ordering `chat.ts` relies on for back-to-back follow-ups.
   */
  { kind: "post"; queued: boolean } | { kind: "advance" } | { kind: "close"; turn: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant("post" as const), queued: fc.boolean() }),
  },
  { weight: 6, arbitrary: fc.constant({ kind: "advance" } as const) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("close" as const), turn: fc.nat({ max: 3 }) }),
  },
);

const scriptArb: fc.Arbitrary<Script> = fc.record({
  deltas: fc.integer({ min: 0, max: 4 }),
  fails: fc.boolean(),
});

/** States the walk must reach — floors asserted after the property. */
const reached = {
  closedMidStream: 0,
  modelFailed: 0,
  refused: 0,
  admittedAfterAbort: 0,
  dispatchedOnClose: 0,
};

type LanguageModelV3StreamPart = Record<string, unknown> & { type: string };

/** A provider whose every part waits on the scheduler, and which honours abort. */
function scheduledModel(s: fc.Scheduler, turn: number, script: Script): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async ({ abortSignal }) => {
      const parts: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        ...Array.from({ length: script.deltas }, (_, i) => ({
          type: "text-delta",
          id: "t",
          delta: `T${turn}.${i};`,
        })),
      ];
      if (!script.fails) {
        parts.push(
          { type: "text-end", id: "t" },
          {
            type: "finish",
            usage: {
              inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 0, text: 0, reasoning: 0 },
            },
            finishReason: { unified: "stop", raw: "stop" },
          },
        );
      }
      let index = 0;
      let settled = false;
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          // A real gateway's fetch errors its body on abort.
          abortSignal?.addEventListener("abort", () => {
            if (settled) return;
            settled = true;
            controller.error(abortSignal.reason);
          });
        },
        async pull(controller) {
          await s.schedule(Promise.resolve(), `turn ${turn} part ${index}`);
          if (settled) return;
          const part = parts[index++];
          if (part) {
            controller.enqueue(part);
            return;
          }
          settled = true;
          if (script.fails) controller.error(new Error(`turn ${turn}: gateway dropped the body`));
          else controller.close();
        },
      });
      return { stream: stream as ReadableStream<never> };
    },
  });
}

/** The parts of a `ServerResponse` the SDK writer and `chat.ts` touch. */
class FakeResponse extends EventEmitter {
  writableEnded = false;
  closed = false;
  readonly body: string[] = [];
  readonly decoder = new TextDecoder();
  setHeaders(): this {
    return this;
  }
  writeHead(): this {
    return this;
  }
  write(chunk: Uint8Array): boolean {
    if (this.closed) return false; // Node: a destroyed response refuses writes, forever
    this.body.push(this.decoder.decode(chunk));
    return true;
  }
  end(): this {
    if (this.writableEnded) return this;
    this.writableEnded = true;
    this.closed = true;
    this.emit("close");
    return this;
  }
  /** The browser going away. */
  clientClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
  frames(): UIMessageChunk[] {
    return this.body
      .join("")
      .split("\n\n")
      .map((frame) => frame.replace(/^data: /, ""))
      .filter((frame) => frame !== "" && frame !== "[DONE]")
      .map((frame) => JSON.parse(frame) as UIMessageChunk);
  }
}

type Turn = {
  index: number;
  script: Script;
  res: FakeResponse;
  finishes: number;
  delivered: boolean;
  closedEarly: boolean;
};

/** One walk's state: the gate, every admitted turn, and their pending deliveries. */
type World = {
  s: fc.Scheduler;
  scripts: readonly Script[];
  gate: ReturnType<typeof createTurnGate>;
  turns: Turn[];
  pending: Promise<unknown>[];
  problems: string[];
};

/** `handleStudioRequest`'s gate check, then `runTurn`'s wiring around `deliverTurn`. */
function post(world: World): void {
  const { turns, problems } = world;
  const index = turns.length;
  const release = world.gate.enter();
  if (!release) {
    reached.refused += 1;
    if (turns.every((turn) => turn.res.closed && turn.finishes > 0)) {
      problems.push(`turn ${index} refused with no turn in flight`);
    }
    return;
  }
  // "A new turn before the previous one SETTLED" is not floored: measured 0
  // in every run, because an abort's short tail reaches `onFinish` within
  // the close's own macrotask. The overlap that IS reachable is the settle's
  // RPCs running into the next turn — `turn-settle-fuzz.test.ts`'s ground.
  if (turns.some((turn) => turn.closedEarly)) reached.admittedAfterAbort += 1;
  if (turns.some((turn) => !turn.res.closed)) {
    problems.push(`turn ${index} admitted while a response is open`);
  }
  const script = world.scripts[index % world.scripts.length] as Script;
  const res = new FakeResponse();
  const turn: Turn = { index, script, res, finishes: 0, delivered: false, closedEarly: false };
  turns.push(turn);
  // `chat.ts`: abort on a close before the end; release on close OR settle.
  const abort = new AbortController();
  res.on("close", () => {
    if (res.writableEnded) return;
    turn.closedEarly = true;
    abort.abort();
  });
  res.on("close", release);
  const result = streamText({
    model: scheduledModel(world.s, index, script),
    prompt: "go",
    abortSignal: abort.signal,
  });
  const delivery = deliverTurn(result, res as unknown as ServerResponse, {
    headers: {},
    originalMessages: [],
    onFinish: () => {
      turn.finishes += 1;
    },
    toErrorText: (error) => (error instanceof Error ? error.message : String(error)),
  });
  world.pending.push(
    delivery
      .then(() => {
        turn.delivered = true;
      })
      .finally(release),
  );
}

/** A post now, or — `queued` — from the open response's close, as the composer does. */
function dispatch(world: World, queued: boolean): void {
  const open = world.turns.find((turn) => !turn.res.closed);
  if (!(queued && open)) {
    post(world);
    return;
  }
  open.res.once("close", () => {
    reached.dispatchedOnClose += 1;
    post(world);
  });
}

/** Everything wrong with one turn's settle and its response's frames. */
function checkTurn(turn: Turn): string[] {
  const problems: string[] = [];
  const name = `turn ${turn.index}`;
  if (turn.finishes !== 1) problems.push(`${name} settled ${turn.finishes} times`);
  if (!(turn.closedEarly || turn.delivered)) problems.push(`${name}: deliverTurn never resolved`);
  const frames = turn.res.frames();
  const deltas = frames.flatMap((frame) => (frame.type === "text-delta" ? [frame.delta] : []));
  const expected = Array.from({ length: turn.script.deltas }, (_, i) => `T${turn.index}.${i};`);
  if (deltas.some((delta, i) => delta !== expected[i])) {
    problems.push(`${name} streamed ${JSON.stringify(deltas)}, not a prefix of its own`);
  }
  if (!turn.closedEarly && deltas.length !== expected.length) {
    problems.push(`${name} delivered ${deltas.length}/${expected.length} deltas while connected`);
  }
  problems.push(...checkErrorFrame(turn, frames));
  return problems;
}

/** An `error` frame is last, and present exactly when a connected turn's model failed. */
function checkErrorFrame(turn: Turn, frames: UIMessageChunk[]): string[] {
  const name = `turn ${turn.index}`;
  const errorAt = frames.findIndex((frame) => frame.type === "error");
  const problems: string[] = [];
  if (errorAt >= 0 && errorAt !== frames.length - 1) {
    problems.push(`${name}: a ${frames[errorAt + 1]?.type} frame followed the error frame`);
  }
  if (errorAt >= 0 && !turn.script.fails) problems.push(`${name}: error frame without a failure`);
  if (turn.script.fails && !turn.closedEarly) {
    reached.modelFailed += 1;
    if (errorAt < 0) problems.push(`${name}: a model failure reached the client as a clean end`);
  }
  return problems;
}

async function runTurns(
  s: fc.Scheduler,
  ops: readonly Op[],
  scripts: readonly Script[],
): Promise<string[]> {
  const world: World = {
    s,
    scripts,
    gate: createTurnGate(),
    turns: [],
    pending: [],
    problems: [],
  };
  for (const op of ops) {
    if (op.kind === "post") dispatch(world, op.queued);
    else if (op.kind === "close") {
      const turn = world.turns[op.turn];
      if (turn && !turn.res.closed) {
        reached.closedMidStream += 1;
        turn.res.clientClose();
      }
    } else if (s.count() > 0) await s.waitNext(1);
    await sleep(0);
  }
  // Fixed rounds rather than `waitFor(Promise.all(pending))`: a delivery whose
  // client closed mid-stream never resolves (see the module doc).
  for (let round = 0; round < 12; round += 1) {
    await s.waitIdle();
    await sleep(0);
  }
  const problems = [...world.problems, ...world.turns.flatMap(checkTurn)];
  // Teardown: every response closed, so no aborted model stream is left open.
  for (const turn of world.turns) turn.res.clientClose();
  await s.waitIdle();
  return problems;
}

test("turns through the gate: one settle each, no stray or misattributed frames", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc
        .array(opArb, { minLength: 1, maxLength: 30 })
        .map((ops) => [{ kind: "post", queued: false } as const, ...ops]),
      fc.array(scriptArb, { minLength: 1, maxLength: 4 }),
      async (s, ops, scripts) => {
        expect(await runTurns(s, ops, scripts)).toEqual([]);
      },
    ),
    { numRuns: 60 },
  );

  // Coverage floors, each under the minimum observed by
  // `pnpm floors:sample --runs 20` (range beside each).
  expect(reached.closedMidStream, "no client ever closed mid-stream").toBeGreaterThan(0); // Measured over 20 runs: 3-17.
  expect(reached.modelFailed, "no connected turn's model ever failed").toBeGreaterThan(15); // Measured over 20 runs: 34-56.
  expect(reached.refused, "no turn was ever refused").toBeGreaterThan(25); // Measured over 20 runs: 52-86.
  expect(reached.admittedAfterAbort, "no turn followed an aborted one").toBeGreaterThan(0); // Measured over 20 runs: 2-17.
  expect(reached.dispatchedOnClose, "no queued turn dispatched on a close").toBeGreaterThan(15); // Measured over 20 runs: 39-57.
});
