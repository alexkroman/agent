// Copyright 2026 the AAI authors. MIT license.
/**
 * Property test: a barge-in (`cancel()`) racing the AssemblyAI TTS socket's
 * trailing frames, a server-side close and the next turn's start.
 *
 * `assemblyai-lifecycle.test.ts`, `assemblyai-turn.test.ts` and
 * `assemblyai-reconnect.test.ts` each pin ONE ordering. Here a fake SERVER sits
 * behind the fake socket and `fc.scheduler` decides when it reads each client
 * frame, when synthesis produces each output frame, and when each one is
 * delivered — while a generated client sends text, flushes, cancels, closes
 * the socket from the far end and lets an unanswered `Cancel` time out. The
 * server answers in order on one socket, as the real one does: that ordering is
 * what `Cancelled` as a boundary rests on, so it is the one thing the scheduler
 * may NOT reorder.
 *
 * Every audio sample, and every word, carries the number of the turn it was
 * synthesized for, so attribution is checked directly. The oracles are
 * `TtsEvents`' own contract (`../openers.ts`): audio and words of a cancelled
 * turn never reach the session, `done` fires exactly once per turn, never
 * before the turn's audio has all arrived, and every turn ends — no hang.
 *
 * The one residual the adapter documents is NOT an oracle: a trailing
 * `WordBoundaries` frame of a turn that ended NORMALLY can land after the next
 * turn's first text and be rebased onto it (`assemblyai.ts`, "The residual is
 * unchanged and unclosable from here"). Only a CANCELLED turn's words are held
 * to the rule.
 */

import { TTS_CANCEL_ACK_TIMEOUT_MS } from "@alexkroman1/aai/host-internal";
import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";
import { flush } from "../../_timing-test-utils.ts";
import type { CreateProviderSocket } from "../_socket.ts";
import type { TtsWordTiming } from "../openers.ts";
import { createFakeWebSocket, FakeWebSocket, pcmBase64 } from "./_fake-ws-test-utils.ts";
import { type AssemblyAITtsSession, openAssemblyAITts } from "./assemblyai.ts";

type ActionKind = "text" | "flush" | "cancel" | "serverClose" | "ackDeadline";

const actionArb: fc.Arbitrary<ActionKind> = fc.oneof(
  { weight: 6, arbitrary: fc.constant("text" as const) },
  { weight: 3, arbitrary: fc.constant("flush" as const) },
  { weight: 3, arbitrary: fc.constant("cancel" as const) },
  { weight: 1, arbitrary: fc.constant("serverClose" as const) },
  { weight: 1, arbitrary: fc.constant("ackDeadline" as const) },
);

/** How the server acknowledges one synthesis — both shapes production sends. */
type AckStyle = "flushDone" | "isFinalThenFlushDone";

type ServerBehavior = {
  ackStyles: readonly AckStyle[];
  /** Audio frames per synthesis, cycled. */
  audioFrames: readonly number[];
  /** Does the server answer a `Cancel` with `Cancelled`? Cycled; mostly yes. */
  answersCancel: readonly boolean[];
};

const behaviorArb: fc.Arbitrary<ServerBehavior> = fc.record({
  ackStyles: fc.array(fc.constantFrom<AckStyle>("flushDone", "isFinalThenFlushDone"), {
    minLength: 1,
    maxLength: 4,
  }),
  audioFrames: fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 4 }),
  answersCancel: fc.array(
    fc.oneof(
      { weight: 5, arbitrary: fc.constant(true) },
      { weight: 1, arbitrary: fc.constant(false) },
    ),
    { minLength: 1, maxLength: 4 },
  ),
});

/** One server-to-client frame, tagged with the turn it belongs to. */
type Frame = {
  payload: { type: string } & Record<string, unknown>;
  turn: number | null;
  audio: boolean;
};

type Server = {
  ws: FakeWebSocket;
  inbox: string[];
  /** Synthesized but not yet on the wire — what a `Cancel` discards. */
  synth: Frame[];
  /** On the wire, in order — what a `Cancel` can no longer recall. */
  wire: Frame[];
  turnOfText: number;
  /** `Cancel` frames the client sent, and `Cancelled` frames delivered back. */
  cancelsSent: number;
  cancelsAnswered: number;
};

const cov = {
  runs: 0,
  cancelsAcked: 0,
  /** A cancelled turn's frame delivered inside the window — what the barrier is for. */
  staleInWindow: 0,
  ackTimeoutReconnects: 0,
  turnsCompleted: 0,
  turnsCancelled: 0,
  turnAfterCancel: 0,
};

/** Read the turn number a frame's samples carry. */
function turnOfAudio(pcm: Int16Array): number {
  return pcm[0] ?? -1;
}

/** The far end of every socket one run opens. */
type Far = {
  s: fc.Scheduler;
  behavior: ServerBehavior;
  cursor: { ack: number; frames: number; cancel: number };
  /** Keyed by socket identity: the session holds its socket as `WebSocket`. */
  servers: Map<object, Server>;
};

function nextOf<T>(far: Far, list: readonly T[], key: keyof Far["cursor"]): T {
  return list[far.cursor[key]++ % list.length] as T;
}

function deliver(server: Server): void {
  const frame = server.wire.shift();
  if (frame === undefined || server.ws.readyState !== FakeWebSocket.OPEN) return;
  if (frame.payload.type === "Cancelled") {
    server.cancelsAnswered++;
    cov.cancelsAcked++;
  } else if (server.cancelsSent > server.cancelsAnswered) cov.staleInWindow++;
  server.ws._msg(frame.payload);
}

function toWire(far: Far, server: Server, frame: Frame): void {
  server.wire.push(frame);
  void far.s.schedule(Promise.resolve(), "deliver").then(() => deliver(server));
}

function produce(far: Far, server: Server): void {
  const frame = server.synth.shift();
  if (frame !== undefined) toWire(far, server, frame);
}

/** Synthesize one `Flush`: its audio, its ack, and the word timings that trail it. */
function synthesize(far: Far, server: Server): void {
  const turn = server.turnOfText;
  const n = nextOf(far, far.behavior.audioFrames, "frames");
  const isFinal = nextOf(far, far.behavior.ackStyles, "ack") === "isFinalThenFlushDone";
  for (let i = 0; i < n; i++) {
    const flagged = isFinal && i === n - 1 ? { is_final: true } : {};
    server.synth.push({
      payload: { type: "Audio", audio: pcmBase64([turn, turn]), ...flagged },
      turn,
      audio: true,
    });
  }
  server.synth.push({ payload: { type: "FlushDone" }, turn, audio: false });
  // Trailing its own ack, as production's does (`assemblyai.ts`).
  server.synth.push({
    payload: { type: "WordBoundaries", words: [{ text: `t${turn}`, start_ms: 0, end_ms: 5 }] },
    turn,
    audio: false,
  });
  for (let i = 0; i < n + 2; i++) {
    void far.s.schedule(Promise.resolve(), "produce").then(() => produce(far, server));
  }
}

/** The server reads the next client frame — in order, as one socket delivers them. */
function receive(far: Far, server: Server): void {
  const raw = server.inbox.shift();
  if (raw === undefined) return;
  const msg = JSON.parse(raw) as { type: string; text?: string };
  if (msg.type === "Generate") {
    server.turnOfText = Number(/t(\d+)/.exec(msg.text ?? "")?.[1] ?? -1);
  } else if (msg.type === "Flush") {
    synthesize(far, server);
  } else if (msg.type === "Cancel") {
    // Aborts synthesis in progress; what is already on the wire still lands.
    server.synth.length = 0;
    if (nextOf(far, far.behavior.answersCancel, "cancel")) {
      toWire(far, server, { payload: { type: "Cancelled" }, turn: null, audio: false });
    }
  }
}

/** The adapter's socket seam: a fake socket with a scheduled server behind it. */
function socketsFor(far: Far): CreateProviderSocket {
  return (url, options) => {
    const ws = new FakeWebSocket(url, options);
    const server: Server = {
      ws,
      inbox: [],
      synth: [],
      wire: [],
      turnOfText: -1,
      cancelsSent: 0,
      cancelsAnswered: 0,
    };
    far.servers.set(ws, server);
    const send = ws.send.bind(ws);
    ws.send = (data: string | Uint8Array) => {
      send(data);
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      if (text.includes('"Cancel"')) server.cancelsSent++;
      server.inbox.push(text);
      void far.s.schedule(Promise.resolve(), "receive").then(() => receive(far, server));
    };
    return ws;
  };
}

/** The client's model of its turns, and the oracles over what the session emits. */
type Near = {
  violations: string[];
  session: AssemblyAITtsSession;
  far: Far;
  turn: number;
  /** Text went out for `turn` and its `done` has not fired yet. */
  open: boolean;
  /** `flush()` ran for `turn`: no more text, the last ack ends it. */
  closed: boolean;
  /** A `done` that fires now is the release `cancel()`/a close owes. */
  releasing: boolean;
  errorsAllowed: boolean;
  cancelled: Set<number>;
  doneCount: Map<number, number>;
  wordsSeq: number;
};

const flag = (near: Near, what: string): void => {
  near.violations.push(what);
};

function liveServer(near: Near): Server | undefined {
  return near.far.servers.get(near.session._ws);
}

function onAudio(near: Near, pcm: Int16Array): void {
  const t = turnOfAudio(pcm);
  if (near.cancelled.has(t)) flag(near, `audio of cancelled turn ${t} reached the session`);
  else if (!near.open || t !== near.turn) {
    flag(near, `audio of turn ${t} reached the session during turn ${near.turn}`);
  }
}

function onWords(near: Near, words: readonly TtsWordTiming[]): void {
  for (const w of words) {
    const t = Number(w.text.slice(1));
    if (near.cancelled.has(t)) flag(near, `words of cancelled turn ${t} reached the session`);
  }
}

/** A `done` nobody released ends a closed turn whose audio has all arrived. */
function checkEarnedDone(near: Near): void {
  if (!near.closed) flag(near, `turn ${near.turn} done before flush()`);
  const server = liveServer(near);
  const owed = [...(server?.synth ?? []), ...(server?.wire ?? [])].filter(
    (f) => f.audio && f.turn === near.turn,
  ).length;
  if (owed > 0) flag(near, `turn ${near.turn} done with ${owed} audio frame(s) still to arrive`);
  cov.turnsCompleted++;
}

function onDone(near: Near): void {
  if (!near.open) {
    flag(near, `done with no turn in flight (after turn ${near.turn})`);
    return;
  }
  near.doneCount.set(near.turn, (near.doneCount.get(near.turn) ?? 0) + 1);
  if (!near.releasing) checkEarnedDone(near);
  near.open = false;
}

/** Run `fn` as a release: a `done` it causes is owed, not earned. */
function releasing(near: Near, fn: () => void): void {
  near.releasing = true;
  try {
    fn();
  } finally {
    near.releasing = false;
  }
}

/** One generated client step. A step whose precondition fails is a no-op. */
const ACTIONS: Record<ActionKind, (near: Near) => void> = {
  text(near) {
    // The pipeline sends no text for a turn it has already flushed.
    if (near.open && near.closed) return;
    if (!near.open) {
      near.turn++;
      near.open = true;
      near.closed = false;
      if (near.cancelled.has(near.turn - 1)) cov.turnAfterCancel++;
    }
    near.session.sendText(`t${near.turn} w${++near.wordsSeq}. `);
  },
  flush(near) {
    if (!near.open || near.closed) return;
    near.closed = true;
    near.session.flush();
  },
  cancel(near) {
    const wasOpen = near.open;
    releasing(near, () => near.session.cancel());
    if (near.open) flag(near, `cancel() of turn ${near.turn} did not release it`);
    if (!wasOpen) return;
    near.cancelled.add(near.turn);
    cov.turnsCancelled++;
  },
  serverClose(near) {
    const server = liveServer(near);
    if (server === undefined || server.ws.readyState !== FakeWebSocket.OPEN) return;
    near.errorsAllowed = true;
    releasing(near, () => server.ws.close());
  },
  ackDeadline(near) {
    const before = near.session._ws;
    vi.advanceTimersByTime(TTS_CANCEL_ACK_TIMEOUT_MS);
    if (near.session._ws !== before) cov.ackTimeoutReconnects++;
  },
};

async function openNear(far: Far): Promise<Near> {
  const opening = openAssemblyAITts({}, socketsFor(far)).open({
    sampleRate: 16_000,
    apiKey: "k",
    signal: new AbortController().signal,
  });
  await flush();
  const near: Near = {
    violations: [],
    session: (await opening) as AssemblyAITtsSession,
    far,
    turn: 0,
    open: false,
    closed: false,
    releasing: false,
    errorsAllowed: false,
    cancelled: new Set(),
    doneCount: new Map(),
    wordsSeq: 0,
  };
  near.session.on("audio", (pcm) => onAudio(near, pcm));
  near.session.on("words", (words) => onWords(near, words));
  near.session.on("done", () => onDone(near));
  near.session.on("error", () => {
    if (!near.errorsAllowed) flag(near, "stream error with the socket healthy");
  });
  return near;
}

/**
 * Liveness: end the open turn the way the pipeline does, and let an unanswered
 * `Cancel` hit its deadline. A turn still open after that hangs the pipeline's
 * flush-wait.
 */
async function checkEveryTurnEnds(near: Near, s: fc.Scheduler): Promise<void> {
  if (near.open && !near.closed) ACTIONS.flush(near);
  await s.waitIdle();
  if (near.open) {
    vi.advanceTimersByTime(TTS_CANCEL_ACK_TIMEOUT_MS);
    await flush();
    await s.waitIdle();
  }
  if (near.open) flag(near, `turn ${near.turn} never ended — done was never emitted`);
  for (const [t, n] of near.doneCount) {
    if (n > 1) flag(near, `turn ${t} emitted done ${n} times`);
  }
}

async function runOne(
  s: fc.Scheduler,
  actions: readonly ActionKind[],
  behavior: ServerBehavior,
): Promise<string[]> {
  const far: Far = { s, behavior, cursor: { ack: 0, frames: 0, cancel: 0 }, servers: new Map() };
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

describe("AssemblyAI TTS: cancel racing the socket", () => {
  test("no cancelled turn's audio leaks, done fires once per turn, and no turn hangs", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(actionArb, { minLength: 3, maxLength: 20 }),
        behaviorArb,
        async (s, actions, behavior) => {
          cov.runs++;
          FakeWebSocket.reset();
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          try {
            const violations = await runOne(s, actions, behavior);
            expect(violations, `${violations.join("\n")}\n${String(s)}`).toEqual([]);
          } finally {
            vi.useRealTimers();
          }
        },
      ),
      { numRuns: 200 },
    );
    // Coverage floors, each under the observed minimum (`pnpm floors:sample
    // --runs 20`): an all-green property proves nothing about a state the
    // generator never reached.
    // Measured over 20 runs: 74-109.
    expect(cov.cancelsAcked, "no Cancel was ever answered").toBeGreaterThan(50);
    // Measured over 20 runs: 345-544.
    expect(cov.staleInWindow, "no stale frame landed inside a cancel window").toBeGreaterThan(250);
    // Measured over 20 runs: 13-32.
    expect(cov.ackTimeoutReconnects, "no unanswered Cancel hit its deadline").toBeGreaterThan(5);
    // Measured over 20 runs: 166-205.
    expect(cov.turnsCompleted, "no turn ever completed").toBeGreaterThan(120);
    // Measured over 20 runs: 166-215.
    expect(cov.turnsCancelled, "no turn was ever cancelled").toBeGreaterThan(120);
    // Measured over 20 runs: 116-160.
    expect(cov.turnAfterCancel, "no turn followed a cancel").toBeGreaterThan(80);
  });

  // The property's second finding, frozen by hand (the shrinker cannot keep a
  // scheduler ordering once the step list shrinks under it): a barge-in AFTER
  // the reply had ended — the commonest kind, the caller talking over the tail
  // of the audio — zeroed the is_final/FlushDone pairing debt, so the ended
  // turn's trailing FlushDone retired one of the next turn's flushes and that
  // turn's `done` overtook its own last segment.
  test("an idle cancel leaves the last turn's trailing FlushDone paired", async () => {
    FakeWebSocket.reset();
    const opening = openAssemblyAITts({}, createFakeWebSocket).open({
      sampleRate: 16_000,
      apiKey: "k",
      signal: new AbortController().signal,
    });
    await flush();
    const session = (await opening) as AssemblyAITtsSession;
    const ws = FakeWebSocket.instances.at(-1) as FakeWebSocket;
    let done = 0;
    session.on("done", () => done++);

    session.sendText("t1 one. ");
    session.flush();
    ws._msg({ type: "Audio", audio: pcmBase64([1]), is_final: true });
    expect(done).toBe(1); // t1's FlushDone is still on the wire
    session.cancel(); // nothing in flight: no Cancel goes out
    session.sendText("t2 two. ");
    session.sendText("t2 three. ");
    ws._msg({ type: "FlushDone" }); // t1's, trailing
    ws._msg({ type: "Audio", audio: pcmBase64([2]), is_final: true }); // t2's first segment
    session.flush();
    expect(done).toBe(1); // t2's second segment has not been synthesized yet
    ws._msg({ type: "Audio", audio: pcmBase64([2]), is_final: true });
    expect(done).toBe(2);
    await session.close();
  });

  // The property's first finding, shrunk: `text, cancel, text, flush` with the
  // `Cancel` never answered. The second turn's flush went out inside the shut
  // window, so its acknowledgement was filtered; the deadline then dropped the
  // socket it was owed on, and the turn's `done` never fired — the pipeline's
  // flush-wait hung on it.
  test("a turn begun under an unanswered Cancel still ends when the deadline drops the socket", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      FakeWebSocket.reset();
      const opener = openAssemblyAITts({}, createFakeWebSocket);
      const opening = opener.open({
        sampleRate: 16_000,
        apiKey: "k",
        signal: new AbortController().signal,
      });
      await flush();
      const session = (await opening) as AssemblyAITtsSession;
      let done = 0;
      session.on("done", () => done++);

      session.sendText("t1 one. ");
      session.cancel();
      expect(done).toBe(1);
      session.sendText("t2 two. ");
      session.flush();
      // The server never answers the Cancel, so nothing it sends is heard.
      vi.advanceTimersByTime(TTS_CANCEL_ACK_TIMEOUT_MS);
      await flush();

      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(done).toBe(2);
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
