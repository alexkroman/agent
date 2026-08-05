// Copyright 2026 the AAI authors. MIT license.
/**
 * FUZZ HARNESS: randomized interleavings of server frames, client
 * control calls, and socket lifecycle events against `createSessionCore`,
 * checking snapshot invariants after every step.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAudioMocks } from "./_react-test-utils.ts";
import { MockWebSocket, makeConfig } from "./_session-core-test-utils.ts";
import { createSessionCore } from "./session-core.ts";
import { loadAudioModules } from "./session-core-audio-setup.ts";
import type { SessionCore, SessionSnapshot } from "./session-core-types.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d_2b_79_f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function noop(): void {
  /* expected console output */
}

type Ctx = {
  core: SessionCore;
  socket: () => MockWebSocket | null;
  rnd: () => number;
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

let toolIdSeq = 0;

function serverOp(ctx: Ctx, op: (typeof SERVER_OPS)[number]): void {
  const ws = ctx.socket();
  if (!ws) return;
  const send = (obj: unknown) => {
    ws.simulateMessage(JSON.stringify(obj));
  };
  switch (op) {
    case "config":
      ws.simulateMessage(makeConfig(16_000, 24_000, "sess-fuzz"));
      break;
    case "speech_started":
      send({ type: "speech_started" });
      break;
    case "user_partial":
      send({ type: "user_transcript_partial", text: "par" });
      break;
    case "user_transcript":
      send({ type: "user_transcript", text: "hello" });
      break;
    case "agent_transcript":
      send({ type: "agent_transcript", text: "hi there" });
      break;
    case "tool_call":
      send({
        type: "tool_call",
        toolCallId: `tc-${++toolIdSeq}`,
        toolName: "lookup",
        args: { q: 1 },
      });
      break;
    case "tool_call_done": {
      // Sometimes complete a real pending call, sometimes an unknown one.
      const pending = ctx.core.getSnapshot().toolCalls.find((tc) => tc.status === "pending");
      const id = pending && ctx.rnd() < 0.8 ? pending.callId : `tc-${++toolIdSeq}`;
      send({ type: "tool_call_done", toolCallId: id, toolName: "lookup", result: "{}" });
      break;
    }
    case "reply_done":
      send({ type: "reply_done" });
      break;
    case "cancelled":
      send({ type: "cancelled" });
      break;
    case "reset":
      send({ type: "reset" });
      break;
    case "custom_event":
      send({ type: "custom_event", event: "ping", data: { n: 1 } });
      break;
    case "agent_state":
      send({ type: "agent_state", state: { cart: [] } });
      break;
    case "error_fatal":
      send({ type: "error", code: "llm", message: "boom" });
      break;
    case "error_nonfatal":
      send({ type: "error", code: "stt", message: "meh", fatal: false });
      break;
    case "idle_timeout":
      send({ type: "idle_timeout" });
      break;
    case "audio_done":
      send({ type: "audio_done" });
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

/** Pick and apply one random operation. */
async function randomStep(ctx: Ctx): Promise<void> {
  const roll = ctx.rnd();
  const pick = <T>(ops: readonly T[]): T => ops[Math.floor(ctx.rnd() * ops.length)] as T;
  if (roll < 0.55) {
    const op = pick(SERVER_OPS);
    ctx.log.push(`server:${op}`);
    serverOp(ctx, op);
  } else if (roll < 0.8) {
    const op = pick(CLIENT_OPS);
    ctx.log.push(`client:${op}`);
    clientOp(ctx, op);
  } else if (roll < 0.92) {
    const op = pick(SOCKET_OPS);
    ctx.log.push(`socket:${op}`);
    socketOp(ctx, op);
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
  checkOrdering(snap, fail);
  if (snap.customEvents.length > SNAPSHOT_CAP) fail("customEvents grew past the cap");
  if (snap.messages.length > SNAPSHOT_CAP) fail("messages grew past the cap");
  if (snap.state === "error" && snap.error === null) fail("error state carries no error");
  if (snap.state === "disconnected" && snap.recording) fail("recording while disconnected");
}

describe("fuzz: session-core interleavings", () => {
  let audio: ReturnType<typeof installAudioMocks>;
  const rejections: unknown[] = [];

  beforeEach(async () => {
    // Warm the memoized audio imports on real timers — module loading is real
    // I/O that fake timers cannot pump, and without a live VoiceIO the fuzz
    // would never exercise the playback/teardown interactions.
    await loadAudioModules();
    vi.useFakeTimers();
    audio = installAudioMocks();
    rejections.length = 0;
    process.on("unhandledRejection", (r) => rejections.push(r));
    vi.spyOn(console, "error").mockImplementation(noop);
    vi.spyOn(console, "warn").mockImplementation(noop);
    vi.spyOn(console, "debug").mockImplementation(noop);
  });

  afterEach(() => {
    audio.restore();
    vi.useRealTimers();
    process.removeAllListeners("unhandledRejection");
  });

  it("holds snapshot invariants across random op sequences", async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rnd = mulberry32(seed);
      let socket: MockWebSocket | null = null;
      const WS = class extends MockWebSocket {
        constructor(url: string) {
          super(url);
          socket = this;
        }
      } as unknown as import("./types.ts").WebSocketConstructor;

      const core = createSessionCore({ platformUrl: "https://host/agent/", WebSocket: WS });
      const log: string[] = [`seed=${seed}`];
      const ctx: Ctx = { core, socket: () => socket, rnd, log };

      let prev = core.getSnapshot();
      for (let i = 0; i < 24; i++) {
        await randomStep(ctx);
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
      expect(
        quiesced.state,
        `seed ${seed}: state moved after teardown (was ${afterTeardown.state})\nops:\n  ${log.join("\n  ")}`,
      ).toBe(fatal ? afterTeardown.state : "disconnected");
      expect(quiesced.recording, `seed ${seed}: recording after teardown`).toBe(false);
      expect(rejections, `unhandled rejections for seed ${seed}`).toEqual([]);
    }
  });
});
