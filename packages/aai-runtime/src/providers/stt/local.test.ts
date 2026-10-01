// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit test for the local-model STT protocol: config frame, frame routing, and
 * the opener's session driven through its socket seam against a fake.
 */

import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { flush } from "../../_timing-test-utils.ts";
import { buildLocalConfigFrame, handleLocalFrame, openLocalStt } from "./local.ts";

function fakeEmit() {
  return { partial: vi.fn(), final: vi.fn(), streamError: vi.fn() };
}

describe("buildLocalConfigFrame", () => {
  test("fills the documented defaults", () => {
    expect(buildLocalConfigFrame({}, 16_000, undefined)).toEqual({
      type: "config",
      sample_rate: 16_000,
      min_turn_silence_ms: 800,
      max_turn_silence_ms: 2000,
    });
  });

  test("forwards language, prompt and silence overrides", () => {
    expect(
      buildLocalConfigFrame(
        { language: "English", minTurnSilenceMs: 200, maxTurnSilenceMs: 3000 },
        24_000,
        "order ids",
      ),
    ).toEqual({
      type: "config",
      sample_rate: 24_000,
      min_turn_silence_ms: 200,
      max_turn_silence_ms: 3000,
      language: "English",
      prompt: "order ids",
    });
  });
});

describe("handleLocalFrame", () => {
  test("routes partial and final, with end-of-turn confidence as meta", () => {
    const emit = fakeEmit();
    handleLocalFrame(JSON.stringify({ type: "partial", text: "I would" }), emit);
    handleLocalFrame(
      JSON.stringify({ type: "final", text: "I would like.", end_of_turn_confidence: 1 }),
      emit,
    );
    expect(emit.partial).toHaveBeenCalledWith("I would", undefined);
    expect(emit.final).toHaveBeenCalledWith("I would like.", { endOfTurnConfidence: 1 });
  });

  test("drops an empty final and an empty partial", () => {
    const emit = fakeEmit();
    handleLocalFrame(JSON.stringify({ type: "final", text: "  " }), emit);
    handleLocalFrame(JSON.stringify({ type: "partial", text: "" }), emit);
    expect(emit.final).not.toHaveBeenCalled();
    expect(emit.partial).not.toHaveBeenCalled();
  });

  test("surfaces a server error", () => {
    const emit = fakeEmit();
    handleLocalFrame(JSON.stringify({ type: "error", message: "model not loaded" }), emit);
    expect(emit.streamError).toHaveBeenCalledWith("Local STT error: model not loaded");
  });

  test("ignores malformed frames without throwing", () => {
    const emit = fakeEmit();
    for (const raw of ["not json", "5", "null", JSON.stringify({ type: "final", text: 7 })]) {
      expect(() => handleLocalFrame(raw, emit)).not.toThrow();
    }
    expect(emit.final).not.toHaveBeenCalled();
  });
});

/** Just enough of a `ws` client for the opener: CONNECTING until `open()`. */
class FakeWs extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  sent: Array<string | Uint8Array> = [];
  readonly target: string;
  readonly clientOptions: WebSocket.ClientOptions;
  constructor(target: string, clientOptions: WebSocket.ClientOptions) {
    super();
    this.target = target;
    this.clientOptions = clientOptions;
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  json(i: number): unknown {
    return JSON.parse(this.sent[i] as string);
  }
}

async function openFake(opts = {}, apiKey = "") {
  let ws: FakeWs | undefined;
  const opening = openLocalStt(opts, (url, options) => {
    ws = new FakeWs(url, options);
    setImmediate(() => ws?.open());
    // The one cast: a real `ws` client cannot stand in, because @types/ws
    // types `new WebSocket(null)` without the options its runtime dereferences.
    return ws as unknown as WebSocket;
  }).open({ sampleRate: 16_000, apiKey, signal: new AbortController().signal });
  const session = await opening;
  if (!ws) throw new Error("socket never created");
  return { session, ws };
}

describe("openLocalStt", () => {
  test("dials the default URL with no auth header, and sends config first", async () => {
    const { session, ws } = await openFake();
    expect(ws.target).toBe("ws://127.0.0.1:8765");
    expect(ws.clientOptions.headers).toEqual({});
    expect(ws.json(0)).toMatchObject({ type: "config", sample_rate: 16_000 });
    await session.close();
  });

  test("sends a bearer token when a key resolved", async () => {
    const { session, ws } = await openFake({ url: "ws://model:9000" }, "tok");
    expect(ws.target).toBe("ws://model:9000");
    expect(ws.clientOptions.headers).toEqual({ Authorization: "Bearer tok" });
    await session.close();
  });

  test("forwards audio as binary PCM and routes server frames", async () => {
    const { session, ws } = await openFake();
    const finals: string[] = [];
    session.on("final", (t) => finals.push(t));
    session.sendAudio(new Int16Array([1, 2, 3]));
    expect((ws.sent[1] as Uint8Array).byteLength).toBe(6);
    ws.emit("message", Buffer.from(JSON.stringify({ type: "final", text: "Hi." })), false);
    ws.emit("message", Buffer.from("ignored"), true);
    expect(finals).toEqual(["Hi."]);
    await session.close();
  });

  test("clamps endpointing updates to the ceiling and skips a no-op", async () => {
    const { session, ws } = await openFake({ maxTurnSilenceMs: 1500 });
    session.updateEndpointing?.(800); // the default already in force
    session.updateEndpointing?.(5000);
    session.forceEndOfTurn?.();
    expect(ws.sent.slice(1).map((f) => JSON.parse(f as string))).toEqual([
      { type: "update", min_turn_silence_ms: 1500 },
      { type: "force_endpoint" },
    ]);
    await session.close();
  });

  test("sends nothing once closed, and a provider close is a stream error", async () => {
    const { session, ws } = await openFake();
    const errors: string[] = [];
    session.on("error", (e) => errors.push(e.code));
    ws.emit("close", 1000);
    await flush();
    expect(errors).toEqual(["stt_stream_error"]);
    await session.close();
    const before = ws.sent.length;
    session.sendAudio(new Int16Array([1]));
    session.forceEndOfTurn?.();
    expect(ws.sent).toHaveLength(before);
  });
});
