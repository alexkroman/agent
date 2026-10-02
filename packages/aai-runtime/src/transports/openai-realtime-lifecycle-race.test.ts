// Copyright 2026 the AAI authors. MIT license.
/**
 * Property test: the OpenAI Realtime lifecycle under every ordering of the
 * connect, a cancel, a barge-in, a hang-up and a far-end close, against the
 * frames of the response each one interrupts.
 *
 * The lifecycle (`openai-realtime-lifecycle.ts`) is synchronous: every
 * interleaving it has to survive is made at the transport, where a socket keeps
 * delivering frames the client can no longer recall. So the machine is driven
 * through `createOpenaiRealtimeTransport` and its `createWebSocket` seam, with a
 * fake SERVER behind a fake socket and `fc.scheduler` deciding when the socket
 * opens, when the server reads each client frame, when it produces each frame
 * of a response and when each one is delivered. The server answers in order on
 * one socket, as the real one does — that ordering is the one thing the
 * scheduler may NOT reorder. A client `close()` leaves what is already on the
 * wire to be delivered, as `ws` does while CLOSING.
 *
 * Every callback the transport makes during a frame's delivery is attributed to
 * that frame's response, so ownership is checked directly. The oracles:
 *
 * - **nothing of an ENDED reply reaches the session** — no audio, transcript,
 *   tool call or second end from a response the transport already reported
 *   done or cancelled, or that the session cancelled;
 * - **each reply ends at most once**, and only one that began;
 * - **nothing after the hang-up**: no reply start, end, error or response
 *   content once `stop()` ran, and no frame sent on a socket the client closed;
 * - **one fatal error**, and only for a close nobody asked for;
 * - **no hang**: `start()` settles however the connect ends.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { silentLogger } from "../_logger-test-utils.ts";
import { flush } from "../_timing-test-utils.ts";
import {
  createOpenaiRealtimeTransport,
  type OpenaiRealtimeWebSocket,
} from "./openai-realtime-transport.ts";
import type { Transport, TransportCallbacks, TransportEventBody } from "./types.ts";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

type ActionKind =
  | "cancel"
  | "toolResult"
  | "userSpeaks"
  | "stop"
  | "farClose"
  | "socketError"
  | "refresh"
  | "audio";

const actionArb: fc.Arbitrary<ActionKind> = fc.oneof(
  { weight: 5, arbitrary: fc.constant("cancel" as const) },
  { weight: 4, arbitrary: fc.constant("toolResult" as const) },
  { weight: 4, arbitrary: fc.constant("userSpeaks" as const) },
  { weight: 1, arbitrary: fc.constant("stop" as const) },
  { weight: 1, arbitrary: fc.constant("farClose" as const) },
  { weight: 1, arbitrary: fc.constant("socketError" as const) },
  { weight: 1, arbitrary: fc.constant("refresh" as const) },
  { weight: 1, arbitrary: fc.constant("audio" as const) },
);

/** How the connect ends — mostly it opens. */
type ConnectOutcome = "open" | "closeBeforeOpen" | "errorBeforeOpen";

type ServerBehavior = {
  connect: ConnectOutcome;
  /** Audio/transcript deltas per response, cycled. */
  deltas: readonly number[];
  /** Does a response call a tool? Cycled. */
  callsTool: readonly boolean[];
  /** Does the greeting go out at all? */
  greets: boolean;
};

const behaviorArb: fc.Arbitrary<ServerBehavior> = fc.record({
  connect: fc.oneof(
    { weight: 8, arbitrary: fc.constant<ConnectOutcome>("open") },
    { weight: 1, arbitrary: fc.constant<ConnectOutcome>("closeBeforeOpen") },
    { weight: 1, arbitrary: fc.constant<ConnectOutcome>("errorBeforeOpen") },
  ),
  deltas: fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 4 }),
  callsTool: fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
  greets: fc.boolean(),
});

const cov = {
  runs: 0,
  opened: 0,
  connectFailures: 0,
  repliesStarted: 0,
  repliesCompleted: 0,
  /** The session cancelled a reply the transport had in flight. */
  cancelsWhileReplying: 0,
  /** A server-VAD barge-in landed on a reply in flight. */
  bargeIns: 0,
  /** A frame of an ended reply was delivered — what the ownership rule is for. */
  staleFrames: 0,
  /** A frame was delivered after the hang-up, on the CLOSING socket. */
  framesAfterStop: 0,
  toolCalls: 0,
  farCloses: 0,
};

/** One server-to-client frame, tagged with the response it belongs to. */
type Frame =
  | { kind: "msg"; payload: { type: string } & Record<string, unknown>; resp: number | null }
  | { kind: "close"; code: number };

/** Every field any of the four socket events carries, so one value fits each listener. */
type SocketEvent = { data: unknown; code?: number; reason?: string; message?: string };

type SocketListener =
  | (() => void)
  | ((event: { data: unknown }) => void)
  | ((event: { code?: number; reason?: string }) => void)
  | ((event: { message?: string }) => void);

/** The listener half of a fake socket, typed as `HeaderWebSocket` declares it. */
abstract class FakeSocket implements OpenaiRealtimeWebSocket {
  readyState = CONNECTING;
  readonly bufferedAmount = 0;
  private readonly listeners = new Map<string, SocketListener[]>();
  abstract send(data: string): void;
  abstract close(code?: number): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
  addEventListener(type: string, listener: SocketListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: "open" | "message" | "close" | "error", ev: SocketEvent = { data: undefined }): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

/** The fake socket the transport holds, and the server at its far end. */
class FarSocket extends FakeSocket {
  clientClosed = false;
  sendsAfterClose = 0;
  private readonly far: Far;
  constructor(far: Far) {
    super();
    this.far = far;
  }
  send(data: string): void {
    if (this.clientClosed || this.readyState !== OPEN) this.sendsAfterClose++;
    this.far.inbox.push(data);
    void this.far.s.schedule(Promise.resolve(), "receive").then(() => receive(this.far));
  }
  close(code?: number): void {
    if (this.clientClosed) return;
    this.clientClosed = true;
    if (this.readyState === CONNECTING) {
      // `ws` aborts the handshake: an `error`, then a `close`.
      this.readyState = CLOSING;
      void this.far.s.schedule(Promise.resolve(), "abort-handshake").then(() => {
        this.emit("error", {
          data: undefined,
          message: "WebSocket was closed before the connection was established",
        });
        this.finish(1006);
      });
      return;
    }
    if (this.readyState !== OPEN) return;
    this.readyState = CLOSING;
    // The server stops producing; what is already on the wire still lands.
    this.far.active = null;
    toWire(this.far, { kind: "close", code: code ?? 1005 });
  }
  finish(code: number): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.far.wire.length = 0;
    this.emit("close", { data: undefined, code, reason: "" });
  }
}

/** The far end of the one socket a run opens. */
type Far = {
  s: fc.Scheduler;
  behavior: ServerBehavior;
  ws: FarSocket | null;
  inbox: string[];
  /** On the wire, in order — what nothing can recall. */
  wire: Frame[];
  /** The response being produced, and its frames not yet on the wire. */
  active: { n: number; pending: Frame[] } | null;
  responses: number;
  cursor: { deltas: number; tool: number };
  /** The response whose frame is being delivered right now. */
  delivering: number | null;
  /** Each response's full transcript, for the committed-text oracle. */
  transcripts: Map<number, string>;
  near: Near | null;
};

function nextOf<T>(far: Far, list: readonly T[], key: keyof Far["cursor"]): T {
  return list[far.cursor[key]++ % list.length] as T;
}

function deliver(far: Far): void {
  const ws = far.ws;
  const frame = far.wire.shift();
  if (frame === undefined || ws === null || ws.readyState === CLOSED) return;
  if (frame.kind === "close") {
    ws.finish(frame.code);
    return;
  }
  const near = far.near;
  if (near !== null) {
    if (near.stopped) cov.framesAfterStop++;
    if (frame.resp !== null && near.ended.has(frame.resp)) cov.staleFrames++;
  }
  far.delivering = frame.resp;
  try {
    ws.emit("message", { data: JSON.stringify(frame.payload) });
  } finally {
    far.delivering = null;
  }
}

function toWire(far: Far, frame: Frame): void {
  far.wire.push(frame);
  void far.s.schedule(Promise.resolve(), "deliver").then(() => deliver(far));
}

function produce(far: Far): void {
  const active = far.active;
  if (active === null) return;
  const frame = active.pending.shift();
  if (frame === undefined) return;
  if (active.pending.length === 0) far.active = null;
  toWire(far, frame);
}

function schedulePending(far: Far, label: string, count: number): void {
  for (let i = 0; i < count; i++) {
    void far.s.schedule(Promise.resolve(), label).then(() => produce(far));
  }
}

const msg = (resp: number | null, payload: { type: string } & Record<string, unknown>): Frame => ({
  kind: "msg",
  payload,
  resp,
});

/** Start one response: `response.created` now, the rest as the model produces it. */
function startResponse(far: Far): void {
  const n = ++far.responses;
  const item = `item_${n}`;
  const deltas = nextOf(far, far.behavior.deltas, "deltas");
  const pending: Frame[] = [];
  pending.push(
    msg(n, {
      type: "response.output_item.added",
      item: { id: item, type: "message" },
    }),
  );
  let text = "";
  for (let i = 0; i < deltas; i++) {
    pending.push(msg(n, { type: "response.output_audio.delta", delta: "AAA=" }));
    const word = `r${n}w${i} `;
    text += word;
    pending.push(
      msg(n, { type: "response.output_audio_transcript.delta", item_id: item, delta: word }),
    );
  }
  far.transcripts.set(n, text);
  pending.push(msg(n, { type: "response.output_audio_transcript.done", item_id: item }));
  pending.push(msg(n, { type: "response.output_audio.done" }));
  if (nextOf(far, far.behavior.callsTool, "tool")) {
    const fc_item = `fc_${n}`;
    pending.push(
      msg(n, {
        type: "response.output_item.added",
        item: { id: fc_item, type: "function_call", name: "lookup", call_id: `call_${n}` },
      }),
    );
    pending.push(
      msg(n, { type: "response.function_call_arguments.delta", item_id: fc_item, delta: '{"r":' }),
    );
    pending.push(
      msg(n, { type: "response.function_call_arguments.delta", item_id: fc_item, delta: `${n}}` }),
    );
    pending.push(msg(n, { type: "response.function_call_arguments.done", item_id: fc_item }));
  }
  pending.push(
    msg(n, { type: "response.done", response: { id: `resp_${n}`, status: "completed" } }),
  );
  far.active = { n, pending };
  toWire(far, msg(n, { type: "response.created", response: { id: `resp_${n}` } }));
  schedulePending(far, `produce-r${n}`, pending.length);
}

/** Abandon the response being produced: OpenAI closes it with a cancelled `response.done`. */
function cancelActive(far: Far): boolean {
  const active = far.active;
  if (active === null) return false;
  far.active = null;
  toWire(
    far,
    msg(active.n, {
      type: "response.done",
      response: { id: `resp_${active.n}`, status: "cancelled" },
    }),
  );
  return true;
}

/** The server reads the next client frame — in order, as one socket delivers them. */
function receive(far: Far): void {
  const raw = far.inbox.shift();
  if (raw === undefined || far.ws === null || far.ws.readyState !== OPEN) return;
  const frame = JSON.parse(raw) as { type: string };
  if (frame.type === "response.create") {
    if (far.active !== null) {
      toWire(far, msg(null, { type: "error", error: { message: "active response" } }));
    } else startResponse(far);
  } else if (frame.type === "response.cancel" && !cancelActive(far)) {
    toWire(far, msg(null, { type: "error", error: { message: "no active response" } }));
  }
}

/** The client's model of its replies, and the oracles over what the transport reports. */
type Near = {
  violations: string[];
  far: Far;
  transport: Transport;
  stopped: boolean;
  /** The reply the transport last started and has not ended. */
  current: number | null;
  /** Replies that are over, by response number. */
  ended: Set<number>;
  fatals: number;
  farClosed: boolean;
  lastCallId: string | null;
  startSettled: boolean;
};

const flag = (near: Near, what: string): void => {
  near.violations.push(what);
};

const respOfId = (id: string): number => Number(/resp_(\d+)/.exec(id)?.[1] ?? -1);

/** A callback that belongs to the frame being delivered: it must not be stale. */
function owned(near: Near, what: string): number | null {
  const n = near.far.delivering;
  if (near.stopped) flag(near, `${what} after stop() (response ${n})`);
  if (n !== null && near.ended.has(n)) flag(near, `${what} of ended response ${n}`);
  return n;
}

function endReply(near: Near, how: string): void {
  const n = owned(near, how);
  if (near.current === null) {
    flag(near, `${how} with no reply in flight (frame of response ${n})`);
    return;
  }
  near.ended.add(near.current);
  near.current = null;
}

function onReport(near: Near, event: TransportEventBody): void {
  switch (event.type) {
    case "reply.completed":
      endReply(near, "reply.completed");
      cov.repliesCompleted++;
      return;
    case "reply.cancelled":
      if (near.current !== null) cov.bargeIns++;
      endReply(near, "reply.cancelled");
      return;
    case "agentTranscript.committed": {
      const n = owned(near, "agentTranscript.committed");
      const full = n === null ? undefined : near.far.transcripts.get(n);
      if (event.text !== full) {
        flag(
          near,
          `response ${n} committed ${JSON.stringify(event.text)}, said ${JSON.stringify(full)}`,
        );
      }
      return;
    }
    case "tool.called":
      owned(near, "tool.called");
      near.lastCallId = event.toolCallId;
      cov.toolCalls++;
      return;
    case "error.reported":
      if (near.stopped) flag(near, `error.reported after stop(): ${event.message}`);
      if (event.fatal === false) return;
      near.fatals++;
      if (near.fatals > 1) flag(near, `fatal error #${near.fatals}: ${event.message}`);
      return;
    default:
      return;
  }
}

function callbacksFor(near: () => Near): TransportCallbacks {
  return {
    report: (event) => onReport(near(), event),
    onAudioChunk: () => {
      owned(near(), "audio");
    },
    onReplyStarted: (replyId) => {
      const n = near();
      owned(n, `onReplyStarted(${replyId})`);
      if (n.current !== null) flag(n, `reply ${replyId} started over reply ${n.current}`);
      n.current = respOfId(replyId);
      cov.repliesStarted++;
    },
  };
}

/** One generated step. A step whose precondition fails is a no-op. */
const ACTIONS: Record<ActionKind, (near: Near) => void> = {
  cancel(near) {
    // The session core forwards a client `cancel` whether or not a reply runs.
    if (near.current !== null) {
      near.ended.add(near.current);
      near.current = null;
      cov.cancelsWhileReplying++;
    }
    near.transport.cancelReply();
  },
  toolResult(near) {
    if (near.lastCallId === null) return;
    near.transport.sendToolResult(near.lastCallId, '{"ok":true}');
    near.lastCallId = null;
  },
  userSpeaks(near) {
    const far = near.far;
    if (far.ws === null || far.ws.readyState !== OPEN) return;
    // Server VAD: the speech edge, the barge-in it implies, then the turn.
    toWire(far, msg(null, { type: "input_audio_buffer.speech_started" }));
    cancelActive(far);
    void far.s.schedule(Promise.resolve(), "vad-turn").then(() => {
      if (far.ws?.readyState !== OPEN) return;
      toWire(far, msg(null, { type: "input_audio_buffer.speech_stopped" }));
      if (far.active === null) startResponse(far);
    });
  },
  stop(near) {
    if (near.stopped) return;
    near.stopped = true;
    if (near.current !== null) near.ended.add(near.current);
    near.current = null;
    void near.transport.stop();
  },
  farClose(near) {
    const ws = near.far.ws;
    if (ws === null || ws.readyState !== OPEN) return;
    near.farClosed = true;
    cov.farCloses++;
    ws.readyState = CLOSING;
    near.far.active = null;
    toWire(near.far, { kind: "close", code: 1006 });
  },
  socketError(near) {
    const ws = near.far.ws;
    if (ws === null || ws.readyState === CONNECTING || ws.readyState === CLOSED) return;
    ws.emit("error", { data: undefined, message: "ECONNRESET" });
  },
  refresh(near) {
    near.transport.refreshSystemPrompt?.();
  },
  audio(near) {
    near.transport.sendUserAudio(new Uint8Array([1, 2]));
  },
};

async function runOne(
  s: fc.Scheduler,
  actions: readonly ActionKind[],
  behavior: ServerBehavior,
): Promise<string[]> {
  const far: Far = {
    s,
    behavior,
    ws: null,
    inbox: [],
    wire: [],
    active: null,
    responses: 0,
    cursor: { deltas: 0, tool: 0 },
    delivering: null,
    transcripts: new Map(),
    near: null,
  };
  let prompt = 0;
  let nearRef: Near | null = null;
  const getNear = (): Near => {
    if (nearRef === null) throw new Error("callback before the run began");
    return nearRef;
  };
  const transport = createOpenaiRealtimeTransport({
    apiKey: "sk",
    options: {},
    sessionConfig: {
      systemPrompt: () => `prompt ${prompt++ >> 1}`,
      ...(behavior.greets ? { greeting: "Hi." } : {}),
    },
    toolSchemas: [],
    toolChoice: "auto",
    callbacks: callbacksFor(getNear),
    sid: "s",
    inputSampleRate: 16_000,
    outputSampleRate: 24_000,
    createWebSocket: () => {
      const ws = new FarSocket(far);
      far.ws = ws;
      void s.schedule(Promise.resolve(), "connect").then(() => {
        if (ws.readyState !== CONNECTING) return;
        if (behavior.connect === "open") {
          ws.readyState = OPEN;
          cov.opened++;
          ws.emit("open");
        } else if (behavior.connect === "errorBeforeOpen") {
          ws.emit("error", { data: undefined, message: "ECONNREFUSED" });
          ws.finish(1006);
        } else ws.finish(4001);
      });
      return ws;
    },
    logger: silentLogger,
  });
  const near: Near = {
    violations: [],
    far,
    transport,
    stopped: false,
    current: null,
    ended: new Set(),
    fatals: 0,
    farClosed: false,
    lastCallId: null,
    startSettled: false,
  };
  nearRef = near;
  far.near = near;
  const started = transport.start().then(
    () => undefined,
    () => {
      cov.connectFailures++;
    },
  );
  void started.then(() => {
    near.startSettled = true;
  });
  try {
    const seq = s.scheduleSequence(
      actions.map((kind, i) => ({
        label: `${i}:${kind}`,
        builder: async () => ACTIONS[kind](near),
      })),
    );
    await s.waitFor(seq.task);
    await s.waitIdle();
    await flush();
    await s.waitIdle();
    if (!near.startSettled) flag(near, "start() never settled");
    if (near.fatals > 0 && !near.farClosed && behavior.connect === "open") {
      flag(near, "a fatal error with no far-end close");
    }
  } finally {
    ACTIONS.stop(near);
    await s.waitIdle();
  }
  if (far.ws !== null && far.ws.sendsAfterClose > 0) {
    flag(near, `${far.ws.sendsAfterClose} frame(s) sent on a closed socket`);
  }
  return near.violations;
}

/** A socket whose frames the spec delivers by hand. */
class ManualSocket extends FakeSocket {
  send(): void {
    // The specs here assert on what reaches the session, not on what goes out.
  }
  // `ws` keeps delivering what is on the wire while CLOSING.
  close(): void {
    this.readyState = CLOSING;
  }
}

/** An open transport over a socket whose frames the spec delivers by hand. */
async function liveTransport() {
  const ws = new ManualSocket();
  const events: TransportEventBody[] = [];
  const cbs = {
    audio: 0,
    types: () => events.map((e) => e.type).filter((t) => t !== "metrics.collected"),
  };
  const transport = createOpenaiRealtimeTransport({
    apiKey: "sk",
    options: {},
    sessionConfig: { systemPrompt: "" },
    toolSchemas: [],
    toolChoice: "auto",
    callbacks: {
      report: (event) => events.push(event),
      onAudioChunk: () => {
        cbs.audio++;
      },
      onReplyStarted: () => undefined,
    },
    sid: "s",
    inputSampleRate: 16_000,
    outputSampleRate: 24_000,
    createWebSocket: () => ws,
    logger: silentLogger,
  });
  const ready = transport.start();
  ws.readyState = OPEN;
  ws.emit("open");
  await ready;
  const frame = (payload: Record<string, unknown>): void => {
    ws.emit("message", { data: JSON.stringify(payload) });
  };
  return { frame, cbs, transport };
}

describe("OpenAI Realtime lifecycle: cancel, barge-in and hang-up racing the socket", () => {
  test("no ended reply's frames reach the session, replies end once, nothing after stop, no hang", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(actionArb, { minLength: 3, maxLength: 16 }),
        behaviorArb,
        async (s, actions, behavior) => {
          cov.runs++;
          const violations = await runOne(s, actions, behavior);
          expect(violations, `${violations.join("\n")}\n${String(s)}`).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
    // Coverage floors, each under the observed minimum (`pnpm floors:sample
    // --runs 20`): an all-green property proves nothing about a state the
    // generator never reached.
    // Measured over 20 runs: 136-166.
    expect(cov.opened, "the socket never opened").toBeGreaterThan(100);
    // Measured over 20 runs: 34-64.
    expect(cov.connectFailures, "no connect ever failed").toBeGreaterThan(20);
    // Measured over 20 runs: 152-218.
    expect(cov.repliesStarted, "no reply ever started").toBeGreaterThan(110);
    // Measured over 20 runs: 53-89.
    expect(cov.repliesCompleted, "no reply ever completed").toBeGreaterThan(35);
    // Measured over 20 runs: 49-80.
    expect(cov.cancelsWhileReplying, "no cancel landed on a reply").toBeGreaterThan(30);
    // Measured over 20 runs: 23-52.
    expect(cov.bargeIns, "no barge-in landed on a reply").toBeGreaterThan(15);
    // Measured over 20 runs: 280-463.
    expect(cov.staleFrames, "no frame of an ended reply was delivered").toBeGreaterThan(200);
    // Measured over 20 runs: 56-123.
    expect(cov.framesAfterStop, "no frame landed after the hang-up").toBeGreaterThan(35);
    // Measured over 20 runs: 30-54.
    expect(cov.toolCalls, "no tool was ever called").toBeGreaterThan(20);
    // Measured over 20 runs: 32-61.
    expect(cov.farCloses, "the far end never closed").toBeGreaterThan(20);
  });

  // The property's findings, frozen by hand (the shrinker cannot keep a
  // scheduler ordering once the step list shrinks under it). Each is a response
  // whose trailing frames were still on the wire when its reply ended.

  test("a cancelled reply's trailing frames reach nobody", async () => {
    const { frame, cbs, transport } = await liveTransport();
    frame({ type: "response.created", response: { id: "resp_1" } });
    frame({ type: "response.output_audio_transcript.delta", item_id: "i1", delta: "Hello " });
    transport.cancelReply();
    // Already on the wire when the `response.cancel` went out.
    frame({ type: "response.output_audio.delta", delta: "AAA=" });
    frame({ type: "response.output_audio_transcript.delta", item_id: "i1", delta: "world" });
    frame({ type: "response.output_audio_transcript.done", item_id: "i1" });
    frame({
      type: "response.output_item.added",
      item: { id: "fc1", type: "function_call", name: "lookup", call_id: "call_1" },
    });
    frame({ type: "response.function_call_arguments.done", item_id: "fc1", arguments: "{}" });
    frame({ type: "response.done", response: { id: "resp_1", status: "cancelled" } });
    expect(cbs.audio).toBe(0);
    expect(cbs.types()).toEqual([]);
  });

  test("a barge-in does not commit the interrupted reply's trailing fragment", async () => {
    const { frame, cbs } = await liveTransport();
    frame({ type: "response.created", response: { id: "resp_1" } });
    frame({ type: "response.output_audio_transcript.delta", item_id: "i1", delta: "Let me " });
    frame({ type: "input_audio_buffer.speech_started" });
    // The interrupted response's tail: the exit cleared "Let me ", so this
    // used to commit "check." to history as the whole reply.
    frame({ type: "response.output_audio_transcript.delta", item_id: "i1", delta: "check." });
    frame({ type: "response.output_audio_transcript.done", item_id: "i1" });
    expect(cbs.types()).toEqual(["reply.cancelled", "speech.started"]);
  });

  test("nothing on a socket still CLOSING after stop() reaches the session", async () => {
    const { frame, cbs, transport } = await liveTransport();
    frame({ type: "response.created", response: { id: "resp_1" } });
    await transport.stop();
    frame({ type: "response.output_audio.delta", delta: "AAA=" });
    frame({ type: "response.output_audio_transcript.delta", item_id: "i1", delta: "Bye." });
    frame({ type: "response.output_audio_transcript.done", item_id: "i1" });
    frame({ type: "input_audio_buffer.speech_started" });
    frame({ type: "error", error: { message: "no active response" } });
    expect(cbs.audio).toBe(0);
    expect(cbs.types()).toEqual([]);
  });
});
