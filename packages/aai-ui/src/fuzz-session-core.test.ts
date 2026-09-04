// Copyright 2026 the AAI authors. MIT license.
/**
 * FUZZ HARNESS: randomized interleavings of server frames, client
 * control calls, and socket lifecycle events against `createBrowserSession`,
 * checking snapshot invariants after every step.
 *
 * Driven by fast-check over a generated op script, so a failure shrinks to the
 * shortest interleaving that still breaks an invariant.
 *
 * Two details this harness needs that the others do not. Unhandled rejections
 * are collected and CLEARED per run: they are process-global, and one left over
 * from an earlier run would fail every later one — including the shrink
 * replays, which would then converge on the wrong counterexample. And the audio
 * mocks plus fake timers are installed once for the whole property rather than
 * per run, because `loadAudioModules` is real I/O that fake timers cannot pump.
 */

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAudioMocks } from "./_react-test-utils.ts";
import {
  type MockWebSocket,
  makeConfig,
  recordingWebSocketClass,
} from "./_session-core-test-utils.ts";
import { createBrowserSession } from "./session-core.ts";
import { loadAudioModules } from "./session-core-audio-setup.ts";
import type { BrowserSession, SessionSnapshot } from "./session-core-types.ts";

function noop(): void {
  /* expected console output */
}

type Ctx = {
  core: BrowserSession;
  socket: () => MockWebSocket | null;
  log: string[];
};

const SERVER_OPS = [
  "config",
  "speech_started",
  "user_partial",
  "user_transcript",
  "agent_transcript",
  "tool_call",
  "tool_call_done",
  "tool_call_done_unknown",
  "reply_done",
  "cancelled",
  "reset",
  "custom_event",
  "agent_state",
  "error_fatal",
  "error_nonfatal",
  "idle_timeout",
  "audio_done",
  "audio_chunk",
  "garbage",
  "unknown_type",
] as const;

const CLIENT_OPS = ["start", "connect", "disconnect", "cancel", "reset", "toggle", "end"] as const;

const SOCKET_OPS = ["open", "close", "error_close"] as const;

/** Snapshot collection cap (`MAX_MESSAGES`/`MAX_CUSTOM_EVENTS` in the core). */
const SNAPSHOT_CAP = 200;

/**
 * States the generator must actually reach, asserted as floors after the run.
 *
 * fast-check has no coverage-floor mechanism (`fc.statistics` only prints), and
 * an all-green property proves nothing about a state the generator never
 * entered — see "Property tests run on fast-check" in the root guide.
 *
 * Every frame here is a no-op when `ctx.socket()` is null, and every invariant
 * in `checkInvariants` is a conditional over a snapshot that may be empty: a
 * run whose socket never opened satisfies all six of them and reports green.
 * These count the states that make the invariants say something.
 *
 * A SETTLED tool call deliberately gets no floor. Reaching one needs a
 * `tool_call` and a matching `tool_call_done` to survive to the same snapshot,
 * which a random 24-step walk over twenty frame kinds effectively never
 * produces (measured: 0-5 across five runs of 200, zero in two of them) — the
 * same shape as the archive path in `studio-concurrency-fuzz.test.ts`, and a
 * floor cannot fix it. Exactly-once tool-call delivery has a property of its
 * own next door in `fuzz-hooks.test.ts`, which drives the collections directly
 * and floors them. *
 * Each floor sits under the OBSERVED MINIMUM across the runs recorded beside
 * it, not at a fixed fraction of the mean. These distributions have long left
 * tails — a counter averaging 38 was measured at 3 on one run — because what a
 * walk reaches is correlated within a run rather than independent per step, so
 * a floor placed under the mean flakes. The job of the floor is to catch a
 * state that is NEVER reached, not to pin how often; a state whose whole range
 * is small therefore gets `> 0`, which is still the assertion that matters.
 */
type Reached = {
  /** Steps applied against a live socket — the only ones that reach the core. */
  liveFrames: number;
  /** Snapshots carrying a committed message, so the ordering scan has input. */
  orderedMessages: number;
  /** Snapshots in the fatal-error state, which the teardown check branches on. */
  fatalStates: number;
};
const reached: Reached = { liveFrames: 0, orderedMessages: 0, fatalStates: 0 };

let toolIdSeq = 0;

function serverOp(ctx: Ctx, op: (typeof SERVER_OPS)[number]): void {
  const ws = ctx.socket();
  // No socket means every server frame below is a no-op. Legitimate — the
  // script may not have started the session yet — but taken on every step it
  // would leave the whole core unexercised, so `reached.liveFrames` floors it.
  if (!ws) return;
  reached.liveFrames += 1;
  const send = (obj: unknown) => {
    ws.simulateMessage(JSON.stringify(obj));
  };
  switch (op) {
    case "config":
      ws.simulateMessage(makeConfig(16_000, 24_000, "sess-fuzz"));
      break;
    case "speech_started":
      send({ type: "speech.started" });
      break;
    case "user_partial":
      send({ type: "user-transcript.updated", text: "par" });
      break;
    case "user_transcript":
      send({ type: "user-transcript.committed", text: "hello" });
      break;
    case "agent_transcript":
      send({ type: "agent-transcript.updated", text: "hi there" });
      break;
    case "tool_call":
      send({
        type: "tool.called",
        toolCallId: `tc-${++toolIdSeq}`,
        toolName: "lookup",
        args: { q: 1 },
      });
      break;
    case "tool_call_done": {
      // Complete a real pending call when there is one. `tool_call_done_unknown`
      // is the other half of what used to be one op with an 80/20 roll inside —
      // split so a counterexample says which case it needed.
      const pending = ctx.core.getSnapshot().toolCalls.find((tc) => tc.status === "pending");
      const id = pending ? pending.callId : `tc-${++toolIdSeq}`;
      send({ type: "tool.completed", toolCallId: id, toolName: "lookup", result: "{}" });
      break;
    }
    case "tool_call_done_unknown":
      send({
        type: "tool.completed",
        toolCallId: `tc-${++toolIdSeq}`,
        toolName: "lookup",
        result: "{}",
      });
      break;
    case "reply_done":
      send({ type: "reply.completed" });
      break;
    case "cancelled":
      send({ type: "reply.cancelled" });
      break;
    case "reset":
      send({ type: "session.reset" });
      break;
    case "custom_event":
      send({ type: "custom.emitted", event: "ping", data: { n: 1 } });
      break;
    case "agent_state":
      send({ type: "state.updated", state: { cart: [] } });
      break;
    case "error_fatal":
      send({ type: "error.reported", code: "llm", message: "boom" });
      break;
    case "error_nonfatal":
      send({ type: "error.reported", code: "stt", message: "meh", fatal: false });
      break;
    case "idle_timeout":
      send({ type: "session.timed-out" });
      break;
    case "audio_done":
      send({ type: "audio.completed" });
      break;
    case "audio_chunk":
      ws.simulateMessage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
      break;
    case "garbage":
      ws.simulateMessage("{not json");
      break;
    case "unknown_type":
      send({ type: "some_future_event", x: 1 });
      break;
    default:
      break;
  }
}

function clientOp(ctx: Ctx, op: (typeof CLIENT_OPS)[number]): void {
  const { core } = ctx;
  switch (op) {
    case "start":
      core.start();
      break;
    case "connect":
      core.connect();
      break;
    case "disconnect":
      core.disconnect();
      break;
    case "cancel":
      core.cancel();
      break;
    case "reset":
      core.reset();
      break;
    case "toggle":
      core.toggle();
      break;
    case "end":
      core.end();
      break;
    default:
      break;
  }
}

function socketOp(ctx: Ctx, op: (typeof SOCKET_OPS)[number]): void {
  const ws = ctx.socket();
  if (!ws) return;
  switch (op) {
    case "open":
      if (ws.readyState === 0) ws.simulateOpen();
      break;
    case "close":
      ws.simulateClose(1000);
      break;
    case "error_close":
      ws.simulateError();
      ws.simulateClose(1006);
      break;
    default:
      break;
  }
}

/**
 * One step of an interleaving. Weights mirror the roll thresholds this harness
 * used before fast-check drove it: mostly server frames, then client control
 * calls, then socket lifecycle, and occasionally a full settle.
 */
type Step =
  | { kind: "server"; op: (typeof SERVER_OPS)[number] }
  | { kind: "client"; op: (typeof CLIENT_OPS)[number] }
  | { kind: "socket"; op: (typeof SOCKET_OPS)[number] }
  | { kind: "settle" };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 55,
    arbitrary: fc.record({
      kind: fc.constant("server" as const),
      op: fc.constantFrom(...SERVER_OPS),
    }),
  },
  {
    weight: 25,
    arbitrary: fc.record({
      kind: fc.constant("client" as const),
      op: fc.constantFrom(...CLIENT_OPS),
    }),
  },
  {
    weight: 12,
    arbitrary: fc.record({
      kind: fc.constant("socket" as const),
      op: fc.constantFrom(...SOCKET_OPS),
    }),
  },
  { weight: 8, arbitrary: fc.record({ kind: fc.constant("settle" as const) }) },
);

/** Apply one generated operation. */
async function applyStep(ctx: Ctx, step: Step): Promise<void> {
  if (step.kind === "server") {
    ctx.log.push(`server:${step.op}`);
    serverOp(ctx, step.op);
  } else if (step.kind === "client") {
    ctx.log.push(`client:${step.op}`);
    clientOp(ctx, step.op);
  } else if (step.kind === "socket") {
    ctx.log.push(`socket:${step.op}`);
    socketOp(ctx, step.op);
  } else {
    ctx.log.push("settle");
    await settle();
  }
}

/** Advance timers + microtasks so every pending async settles. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
  await vi.advanceTimersByTimeAsync(70_000);
  for (let i = 0; i < 6; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

/** Strictly increasing per-collection sequence numbers. */
function checkOrdering(snap: SessionSnapshot, fail: (why: string) => never): void {
  const increasing = (values: number[], label: string): void => {
    let last = -1;
    for (const v of values) {
      if (v <= last) fail(`${label} not strictly increasing`);
      last = v;
    }
  };
  increasing(
    snap.messages.map((m) => m.id),
    "message ids",
  );
  increasing(
    snap.toolCalls.map((tc) => tc.seq),
    "toolCall seqs",
  );
  increasing(
    snap.customEvents.map((ce) => ce.id),
    "customEvent ids",
  );
}

function checkInvariants(snap: SessionSnapshot, prev: SessionSnapshot, log: string[]): void {
  const fail = (why: string): never => {
    throw new Error(`${why}\nops:\n  ${log.join("\n  ")}\nsnapshot: ${JSON.stringify(snap)}`);
  };
  if (snap.contentVersion < prev.contentVersion) fail("contentVersion went backwards");
  if (snap.messages.length > 0) reached.orderedMessages += 1;
  if (snap.state === "error") reached.fatalStates += 1;
  checkOrdering(snap, fail);
  if (snap.customEvents.length > SNAPSHOT_CAP) fail("customEvents grew past the cap");
  if (snap.messages.length > SNAPSHOT_CAP) fail("messages grew past the cap");
  if (snap.state === "error" && snap.error === null) fail("error state carries no error");
  if (snap.state === "disconnected" && snap.recording) fail("recording while disconnected");
}

describe("fuzz: session-core interleavings", () => {
  let audio: ReturnType<typeof installAudioMocks>;
  const rejections: unknown[] = [];
  // Named, so afterEach can remove exactly THIS listener. The teardown used
  // `process.removeAllListeners("unhandledRejection")`, which strips every
  // listener on the process — vitest's own included, plus any installed by
  // another test file sharing this worker. A harness that disarms someone
  // else's rejection guard is worse than one that leaks its own.
  const onUnhandledRejection = (reason: unknown) => rejections.push(reason);

  beforeEach(async () => {
    // Warm the memoized audio imports on real timers — module loading is real
    // I/O that fake timers cannot pump, and without a live VoiceIO the fuzz
    // would never exercise the playback/teardown interactions.
    await loadAudioModules();
    vi.useFakeTimers();
    audio = installAudioMocks();
    rejections.length = 0;
    process.on("unhandledRejection", onUnhandledRejection);
    vi.spyOn(console, "error").mockImplementation(noop);
    vi.spyOn(console, "warn").mockImplementation(noop);
    vi.spyOn(console, "debug").mockImplementation(noop);
  });

  afterEach(() => {
    audio.restore();
    vi.useRealTimers();
    process.off("unhandledRejection", onUnhandledRejection);
  });

  /**
   * Drive one interleaving, then tear the session down and check it quiesces.
   * Returns the problems found, so every violation reaches the property with
   * the op log attached rather than throwing past it.
   */
  async function runScript(steps: readonly Step[]): Promise<string[]> {
    // Process-global, so clear before the run: a rejection left by an earlier
    // run would be reported against this one and mislead the shrinker.
    rejections.length = 0;
    let socket: MockWebSocket | null = null;
    const WS = recordingWebSocketClass((s) => {
      socket = s;
    });

    const core = createBrowserSession({ platformUrl: "https://host/agent/", WebSocket: WS });
    const log: string[] = [];
    const ctx: Ctx = { core, socket: () => socket, log };

    let prev = core.getSnapshot();
    for (const step of steps) {
      await applyStep(ctx, step);
      const snap = core.getSnapshot();
      checkInvariants(snap, prev, log);
      prev = snap;
    }
    await settle();
    checkInvariants(core.getSnapshot(), prev, log);

    // Put the session mid-reply where possible, so the teardown below has a
    // pending playback drain to race with (microtask flush only — advancing
    // the clock here would settle the very drain under test).
    serverOp(ctx, "audio_chunk");
    serverOp(ctx, "audio_done");
    await vi.advanceTimersByTimeAsync(0);

    // Quiescence: after an explicit teardown with no further server frames,
    // no late async continuation may write session state again.
    const fatal = core.getSnapshot().state === "error";
    core.disconnect();
    const afterTeardown = core.getSnapshot();
    await settle();
    const quiesced = core.getSnapshot();

    const problems: string[] = [];
    const expectedState = fatal ? afterTeardown.state : "disconnected";
    if (quiesced.state !== expectedState) {
      problems.push(
        `state moved after teardown: ${afterTeardown.state} -> ${quiesced.state}, expected ${expectedState}`,
      );
    }
    if (quiesced.recording) problems.push("recording after teardown");
    for (const rejection of rejections) problems.push(`unhandled rejection: ${String(rejection)}`);
    return problems.map((problem) => `${problem}\nops:\n  ${log.join("\n  ")}`);
  }

  it("holds snapshot invariants across random op sequences", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 24 }), async (steps) => {
        expect(await runScript(steps)).toEqual([]);
      }),
      { numRuns: 200 },
    );

    // Coverage floors — see `Reached` for how these are placed. Ranges are
    // over 27 runs of 200.
    expect(
      reached.liveFrames,
      "no server frame ever reached a live socket — the whole core went unexercised",
    ).toBeGreaterThan(110); // 403-513
    expect(
      reached.orderedMessages,
      "no snapshot ever held a message — the ordering scan had nothing to scan",
      // The long tail these floors were calibrated on: a committed message needs
      // a live socket AND a `user_transcript`/`reply_done` after it, and whether
      // the socket opens early is decided once per run rather than per step.
      // Mean ~38, measured as low as 3. Two earlier drafts (10, then 3) each
      // tripped on a real run.
    ).toBeGreaterThan(0);
    expect(
      reached.fatalStates,
      "no run ever reached the error state — the fatal branch of the teardown check went untaken",
    ).toBeGreaterThan(12); // 44-113
  }, 120_000);
});
