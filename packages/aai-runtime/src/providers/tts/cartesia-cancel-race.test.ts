// Copyright 2026 the AAI authors. MIT license.
/**
 * Property test: barge-in (`cancel()`), `flush()` and the next turn's text
 * racing the Cartesia socket's trailing per-context frames.
 *
 * `cartesia.test.ts` pins ONE ordering per case. Here a fake SERVER sits behind
 * the fake `TTSWS` and `fc.scheduler` decides when it reads each client
 * request, when synthesis produces each output frame, and when each one is
 * delivered — while a generated client sends text, flushes, cancels, closes the
 * session and errors the socket. The server answers in order on one socket, as
 * the real one does; that ordering is the one thing the scheduler may NOT
 * reorder.
 *
 * The server models Cartesia's per-context protocol: `continue: true` appends
 * to a context, an empty `continue: false` finalizes it (its audio, then its
 * `done`), `cancel` discards what is not yet on the wire, and any request for a
 * cancelled or finished context is answered with the dead-context 400 the
 * adapter must treat as benign.
 *
 * Every audio sample carries the number of the turn it was synthesized for, so
 * attribution is checked directly. The oracles are `TtsEvents`' own contract
 * (`../openers.ts`): a cancelled turn's audio never reaches the session, audio
 * only plays inside its own turn, `done` fires exactly once per turn and never
 * with no turn in flight, an earned `done` never overtakes its turn's audio,
 * every turn ends, and nothing is emitted after `close()`.
 *
 * NOT modelled, because the adapter cannot see it: a server-side close.
 * cartesia-js's `TTSWS` binds no `close` listener and reconnects transparently
 * on the next `send` (`_ensureConnected`), so a turn flushed before the drop
 * never gets its `done` and only the pipeline's flush timeout ends it.
 */

import type { WebsocketResponse } from "@cartesia/cartesia-js/resources/tts";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  type CartesiaContext,
  type CartesiaSession,
  type CartesiaSocket,
  type CreateCartesiaSocket,
  openCartesia,
} from "./cartesia.ts";

type ActionKind = "text" | "flush" | "cancel" | "socketError" | "close";

const actionArb: fc.Arbitrary<ActionKind> = fc.oneof(
  { weight: 12, arbitrary: fc.constant("text" as const) },
  { weight: 6, arbitrary: fc.constant("flush" as const) },
  { weight: 6, arbitrary: fc.constant("cancel" as const) },
  { weight: 1, arbitrary: fc.constant("socketError" as const) },
  { weight: 1, arbitrary: fc.constant("close" as const) },
);

type ServerBehavior = {
  /** Audio frames synthesized per `continue: true` request, cycled. */
  audioFrames: readonly number[];
};

const behaviorArb: fc.Arbitrary<ServerBehavior> = fc.record({
  audioFrames: fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 4 }),
});

/** One server-to-client frame, tagged with the turn it belongs to. */
type Frame =
  | { kind: "chunk"; contextId: string; turn: number }
  | { kind: "done"; contextId: string; turn: number }
  | { kind: "error"; contextId: string };

type ServerContext = { turn: number; finalized: boolean; cancelled: boolean; doneSent: boolean };

type Request =
  | { kind: "send"; contextId: string; transcript: string; cont: boolean }
  | { kind: "cancel"; contextId: string };

const cov = {
  runs: 0,
  turnsCompleted: 0,
  turnsCancelled: 0,
  turnAfterCancel: 0,
  /** A cancelled turn's audio delivered while its context is still the active one. */
  staleAudioInWindow: 0,
  /** A dead-context 400 delivered to the adapter. */
  deadContextErrors: 0,
  /** `cancel()` after the turn's `done` already fired — the idle barge-in. */
  idleCancels: 0,
};

type Far = {
  s: fc.Scheduler;
  behavior: ServerBehavior;
  cursor: number;
  listeners: Map<string, Array<(payload: unknown) => void>>;
  inbox: Request[];
  /** Synthesized but not yet on the wire — what a `cancel` discards. */
  synth: Frame[];
  /** On the wire, in order — what a `cancel` can no longer recall. */
  wire: Frame[];
  contexts: Map<string, ServerContext>;
  /** Set by the client model: the context the adapter considers active. */
  activeContextId: () => string;
  isCancelled: (turn: number) => boolean;
};

function fire(far: Far, event: string, payload: unknown): void {
  for (const fn of far.listeners.get(event) ?? []) fn(payload);
}

function pcmBytes(turn: number): Uint8Array {
  return new Uint8Array(new Int16Array([turn, turn]).buffer);
}

function deliver(far: Far): void {
  const frame = far.wire.shift();
  if (frame === undefined) return;
  if (frame.kind === "chunk") {
    if (far.isCancelled(frame.turn) && frame.contextId === far.activeContextId()) {
      cov.staleAudioInWindow++;
    }
    const chunk: Pick<WebsocketResponse.Chunk, "context_id" | "audio"> = {
      context_id: frame.contextId,
      audio: pcmBytes(frame.turn),
    };
    fire(far, "chunk", chunk);
  } else if (frame.kind === "done") {
    fire(far, "done", { context_id: frame.contextId });
  } else {
    cov.deadContextErrors++;
    const body = {
      type: "error",
      context_id: frame.contextId,
      status_code: 400,
      title: "Invalid context ID",
      message: "The requested context ID does not exist or may have already been cancelled.",
    };
    fire(far, "error", new Error(JSON.stringify(body)));
  }
}

function toWire(far: Far, frame: Frame): void {
  far.wire.push(frame);
  void far.s.schedule(Promise.resolve(), "deliver").then(() => deliver(far));
}

function produce(far: Far): void {
  const frame = far.synth.shift();
  if (frame === undefined) return;
  if (frame.kind === "done") {
    const ctx = far.contexts.get(frame.contextId);
    if (ctx) ctx.doneSent = true;
  }
  toWire(far, frame);
}

function synthesize(far: Far, frame: Frame): void {
  far.synth.push(frame);
  void far.s.schedule(Promise.resolve(), "produce").then(() => produce(far));
}

/** The server reads the next client request — in order, as one socket delivers them. */
function receive(far: Far): void {
  const req = far.inbox.shift();
  if (req === undefined) return;
  const ctx = far.contexts.get(req.contextId);
  if (req.kind === "cancel") {
    if (ctx === undefined || ctx.cancelled || ctx.doneSent) {
      toWire(far, { kind: "error", contextId: req.contextId });
      return;
    }
    // Aborts synthesis in progress; what is already on the wire still lands.
    ctx.cancelled = true;
    far.synth = far.synth.filter((f) => f.contextId !== req.contextId);
    return;
  }
  if (ctx?.cancelled || ctx?.finalized) {
    toWire(far, { kind: "error", contextId: req.contextId });
    return;
  }
  const turn = Number(/t(\d+)/.exec(req.transcript)?.[1] ?? ctx?.turn ?? -1);
  const live = ctx ?? { turn, finalized: false, cancelled: false, doneSent: false };
  far.contexts.set(req.contextId, live);
  if (req.cont) {
    const n = far.behavior.audioFrames[far.cursor++ % far.behavior.audioFrames.length] ?? 1;
    for (let i = 0; i < n; i++) {
      synthesize(far, { kind: "chunk", contextId: req.contextId, turn: live.turn });
    }
  } else {
    live.finalized = true;
    synthesize(far, { kind: "done", contextId: req.contextId, turn: live.turn });
  }
}

function enqueue(far: Far, req: Request): void {
  far.inbox.push(req);
  void far.s.schedule(Promise.resolve(), "receive").then(() => receive(far));
}

/** The adapter's socket seam: a fake `TTSWS` with a scheduled server behind it. */
function socketFor(far: Far): CreateCartesiaSocket {
  return () => {
    const ws: CartesiaSocket = {
      on<P>(event: string, fn: (payload: P) => void) {
        const list = far.listeners.get(event) ?? [];
        // The fake server names the event and supplies its payload.
        list.push((payload) => fn(payload as P));
        far.listeners.set(event, list);
        return ws;
      },
      async connect() {
        return ws;
      },
      close() {
        far.listeners.clear();
      },
      context(options): CartesiaContext {
        const contextId = options.contextId ?? "";
        return {
          contextId,
          async send(req) {
            enqueue(far, {
              kind: "send",
              contextId,
              transcript: req.transcript,
              cont: req.continue ?? false,
            });
          },
          async cancel() {
            enqueue(far, { kind: "cancel", contextId });
          },
        };
      },
    };
    return ws;
  };
}

/** The client's model of its turns, and the oracles over what the session emits. */
type Near = {
  violations: string[];
  session: CartesiaSession;
  far: Far;
  turn: number;
  /** Text went out for `turn` and its `done` has not fired yet. */
  open: boolean;
  /** `flush()` ran for `turn`: no more text, its `done` ends it. */
  closed: boolean;
  /** A `done` that fires now is the release `cancel()` owes. */
  releasing: boolean;
  /** The session was closed or errored: it must stay silent from here. */
  ended: boolean;
  errorsAllowed: boolean;
  cancelled: Set<number>;
  doneCount: Map<number, number>;
};

const flag = (near: Near, what: string): void => {
  near.violations.push(what);
};

function onAudio(near: Near, pcm: Int16Array): void {
  const t = pcm[0] ?? -1;
  if (near.ended) flag(near, `audio of turn ${t} after the session ended`);
  else if (near.cancelled.has(t)) flag(near, `audio of cancelled turn ${t} reached the session`);
  else if (!near.open || t !== near.turn) {
    flag(near, `audio of turn ${t} reached the session during turn ${near.turn}`);
  }
}

/** A `done` nobody released ends a flushed turn whose audio has all arrived. */
function checkEarnedDone(near: Near): void {
  if (!near.closed) flag(near, `turn ${near.turn} done before flush()`);
  const owed = [...near.far.synth, ...near.far.wire].filter(
    (f) => f.kind === "chunk" && f.turn === near.turn,
  ).length;
  if (owed > 0) flag(near, `turn ${near.turn} done with ${owed} audio frame(s) still to arrive`);
  cov.turnsCompleted++;
}

function onDone(near: Near): void {
  if (near.ended) {
    flag(near, "done after the session ended");
    return;
  }
  if (!near.open) {
    flag(near, `done with no turn in flight (after turn ${near.turn})`);
    return;
  }
  near.doneCount.set(near.turn, (near.doneCount.get(near.turn) ?? 0) + 1);
  if (!near.releasing) checkEarnedDone(near);
  near.open = false;
}

/** One generated client step. A step whose precondition fails is a no-op. */
const ACTIONS: Record<ActionKind, (near: Near) => void | Promise<void>> = {
  text(near) {
    if (near.ended) return;
    // The pipeline sends no text for a turn it has already flushed.
    if (near.open && near.closed) return;
    if (!near.open) {
      near.turn++;
      near.open = true;
      near.closed = false;
      if (near.cancelled.has(near.turn - 1)) cov.turnAfterCancel++;
    }
    near.session.sendText(`t${near.turn} word. `);
  },
  flush(near) {
    if (near.ended || !near.open || near.closed) return;
    near.closed = true;
    near.session.flush();
  },
  cancel(near) {
    if (near.ended) return;
    const wasOpen = near.open;
    near.releasing = true;
    try {
      near.session.cancel();
    } finally {
      near.releasing = false;
    }
    if (near.open) flag(near, `cancel() of turn ${near.turn} did not release it`);
    if (!wasOpen) {
      if (near.turn > 0) cov.idleCancels++;
      return;
    }
    near.cancelled.add(near.turn);
    cov.turnsCancelled++;
  },
  async socketError(near) {
    if (near.ended) return;
    near.errorsAllowed = true;
    fire(near.far, "error", new Error("connection reset by peer"));
    // `error` is terminal but does not close the shell itself: the consumer
    // closes the session, as the pipeline does.
    near.ended = true;
    await near.session.close();
  },
  async close(near) {
    if (near.ended) return;
    near.ended = true;
    await near.session.close();
  },
};

async function openNear(far: Far): Promise<Near> {
  const session = (await openCartesia({ voice: "v" }, socketFor(far)).open({
    sampleRate: 16_000,
    apiKey: "k",
    signal: new AbortController().signal,
  })) as CartesiaSession;
  const near: Near = {
    violations: [],
    session,
    far,
    turn: 0,
    open: false,
    closed: false,
    releasing: false,
    ended: false,
    errorsAllowed: false,
    cancelled: new Set(),
    doneCount: new Map(),
  };
  far.activeContextId = () => session._currentContextId();
  far.isCancelled = (turn) => near.cancelled.has(turn);
  session.on("audio", (pcm) => onAudio(near, pcm));
  session.on("done", () => onDone(near));
  session.on("error", () => {
    if (!near.errorsAllowed) flag(near, "stream error with the socket healthy");
  });
  return near;
}

/** Liveness: end the open turn the way the pipeline does; it must then end. */
async function checkEveryTurnEnds(near: Near, s: fc.Scheduler): Promise<void> {
  if (!near.ended && near.open && !near.closed) ACTIONS.flush(near);
  await s.waitIdle();
  if (!near.ended && near.open) flag(near, `turn ${near.turn} never ended — done never fired`);
  for (const [t, n] of near.doneCount) {
    if (n > 1) flag(near, `turn ${t} emitted done ${n} times`);
  }
}

async function runOne(
  s: fc.Scheduler,
  actions: readonly ActionKind[],
  behavior: ServerBehavior,
): Promise<string[]> {
  const far: Far = {
    s,
    behavior,
    cursor: 0,
    listeners: new Map(),
    inbox: [],
    synth: [],
    wire: [],
    contexts: new Map(),
    activeContextId: () => "",
    isCancelled: () => false,
  };
  const near = await openNear(far);
  try {
    const seq = s.scheduleSequence(
      actions.map((kind, i) => ({
        label: `${i}:${kind}`,
        builder: async () => ACTIONS[kind](near),
      })),
    );
    await s.waitFor(seq.task);
    await s.waitIdle();
    await checkEveryTurnEnds(near, s);
  } finally {
    await near.session.close();
    await s.waitIdle();
  }
  return near.violations;
}

describe("Cartesia TTS: cancel racing the socket", () => {
  test("no cancelled turn's audio leaks, done fires once per turn, and no turn hangs", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(actionArb, { minLength: 3, maxLength: 24 }),
        behaviorArb,
        async (s, actions, behavior) => {
          cov.runs++;
          const violations = await runOne(s, actions, behavior);
          expect(violations, `${violations.join("\n")}\n${String(s)}`).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
    // Coverage floors, each under the observed minimum (`pnpm floors:sample
    // --runs 20`): an all-green property proves nothing about a state the
    // generator never reached.
    // Measured over 20 runs: 117-154.
    expect(cov.turnsCompleted, "no turn ever completed").toBeGreaterThan(90);
    // Measured over 20 runs: 195-257.
    expect(cov.turnsCancelled, "no turn was ever cancelled").toBeGreaterThan(150);
    // Measured over 20 runs: 123-179.
    expect(cov.turnAfterCancel, "no turn followed a cancel").toBeGreaterThan(100);
    // Measured over 20 runs: 129-207.
    expect(
      cov.staleAudioInWindow,
      "no cancelled turn's audio landed in its window",
    ).toBeGreaterThan(100);
    // Measured over 20 runs: 18-46.
    expect(cov.deadContextErrors, "no dead-context 400 was ever delivered").toBeGreaterThan(10);
    // Measured over 20 runs: 60-109.
    expect(cov.idleCancels, "no barge-in came after a turn had ended").toBeGreaterThan(40);
  });

  // The property's finding, shrunk to `cancel` on a fresh session: the
  // pipeline cancels TTS on EVERY barge-in, so a caller who speaks before the
  // agent has said anything got a `done` with no turn in flight, and a wire
  // cancel for a context Cartesia had never seen (answered by a dead-context
  // 400).
  test("a cancel before any text emits no done and sends nothing", async () => {
    const sent: string[] = [];
    const ws: CartesiaSocket = {
      on: () => ws,
      connect: async () => ws,
      close: () => undefined,
      context: (options) => ({
        contextId: options.contextId ?? "",
        send: async (req) => void sent.push(`send ${req.transcript}`),
        cancel: async () => void sent.push("cancel"),
      }),
    };
    const session = await openCartesia({ voice: "v" }, () => ws).open({
      sampleRate: 16_000,
      apiKey: "k",
      signal: new AbortController().signal,
    });
    let done = 0;
    session.on("done", () => done++);

    session.cancel();
    await Promise.resolve();
    expect(done).toBe(0);
    expect(sent).toEqual([]);

    // The first real turn still cancels normally.
    session.sendText("t1 one. ");
    session.cancel();
    await Promise.resolve();
    expect(done).toBe(1);
    expect(sent).toEqual(["send t1 one. ", "cancel"]);
    await session.close();
  });
});
