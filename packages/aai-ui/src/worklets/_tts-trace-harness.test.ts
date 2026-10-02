// Copyright 2026 the AAI authors. MIT license.
/**
 * The TTS trace harness — capturing one reply's bytes and arrival times, and
 * reading a recorded one back.
 *
 * The capture is driven against a scripted session (a real provider is what
 * `captureTtsTrace` exists to record, and would make this a network test);
 * the readers against the committed `fixtures/tts-reply-24k` trace, which they
 * only READ. `writeTtsTrace` is the one function left to its caller: it writes
 * files, which the unit tier forbids.
 */

import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  type CapturableTtsSession,
  captureTtsTrace,
  frameBytes,
  hasTtsTrace,
  readTtsTrace,
  readTtsTraceSync,
  splitIntoDeltas,
  traceAudioMs,
  tracePaths,
} from "./_tts-trace-harness.ts";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const TRACE = "tts-reply-24k";

/**
 * What one listener is handed. An intersection, so the one `on` below satisfies
 * all three of the session's overloads without a cast: each overload's handler
 * accepts this.
 */
type Emitted = Int16Array & { message?: string };

/**
 * A session that answers `flush()` with the given PCM frames and then `done`
 * — or, given `error`, with that error instead — recording every delta sent.
 */
function scriptedSession(
  frames: Int16Array[],
  error?: string,
): CapturableTtsSession & { sent: string[]; close: ReturnType<typeof vi.fn> } {
  const listeners = new Map<string, (arg: Emitted) => void>();
  const sent: string[] = [];
  return {
    sent,
    sendText: (text) => sent.push(text),
    flush: () => {
      if (error !== undefined) {
        listeners.get("error")?.(Object.assign(new Int16Array(0), { message: error }));
        return;
      }
      for (const frame of frames) listeners.get("audio")?.(frame);
      listeners.get("done")?.(new Int16Array(0));
    },
    on: (event: string, fn: (arg: Emitted) => void) => listeners.set(event, fn),
    close: vi.fn(async () => undefined),
  };
}

describe("splitIntoDeltas", () => {
  test("groups words into deltas that rejoin to the exact text", () => {
    const text = "one two three four five six seven";
    const deltas = splitIntoDeltas(text, 3);
    expect(deltas).toEqual(["one two three ", "four five six ", "seven"]);
    expect(deltas.join("")).toBe(text);
  });

  test("an empty text is no deltas", () => {
    expect(splitIntoDeltas("")).toEqual([]);
  });
});

describe("captureTtsTrace", () => {
  test("records every frame's bytes, in order, with offsets that tile the PCM", async () => {
    const session = scriptedSession([new Int16Array([1, 2, 3]), new Int16Array([4, 5])]);
    const trace = await captureTtsTrace({
      text: "hello there world",
      open: async () => session,
    });

    expect(Array.from(trace.pcm)).toEqual([1, 2, 3, 4, 5]);
    expect(trace.frames.map(({ offset, length }) => [offset, length])).toEqual([
      [0, 6],
      [6, 4],
    ]);
    expect(trace).toMatchObject({ sampleRate: 24_000, provider: "assemblyai", voice: "jane" });
    expect(trace.firstAudioMs).toBeGreaterThanOrEqual(0);
    expect(trace.doneMs).toBeGreaterThanOrEqual(trace.firstAudioMs);
    // The text went out as deltas, the way an LLM stream would send it.
    expect(session.sent.join("")).toBe("hello there world");
    expect(session.close).toHaveBeenCalledOnce();
  });

  test("a provider error rejects the capture and still closes the session", async () => {
    const session = scriptedSession([], "voice not found");
    await expect(captureTtsTrace({ text: "hi", open: async () => session })).rejects.toThrow(
      "tts error: voice not found",
    );
    expect(session.close).toHaveBeenCalledOnce();
  });
});

describe("reading a recorded trace", () => {
  test("names the index and the PCM side by side", () => {
    expect(tracePaths("/d", "t")).toEqual({ index: "/d/t.json", pcm: "/d/t.pcm" });
  });

  test("knows when a trace is missing", () => {
    expect(hasTtsTrace(FIXTURES, "no-such-trace")).toBe(false);
  });
});

describe.skipIf(!hasTtsTrace(FIXTURES, TRACE))("the committed trace", () => {
  test("the sync and async readers agree, and every frame lies inside the PCM", async () => {
    const sync = readTtsTraceSync(FIXTURES, TRACE);
    const async = await readTtsTrace(FIXTURES, TRACE);
    expect(async.frames).toEqual(sync.frames);
    expect(Array.from(async.pcm.subarray(0, 64))).toEqual(Array.from(sync.pcm.subarray(0, 64)));

    expect(traceAudioMs(sync)).toBeCloseTo((sync.pcm.length / sync.sampleRate) * 1000);
    const total = sync.frames.reduce((sum, frame) => sum + frameBytes(sync, frame).byteLength, 0);
    expect(total).toBe(sync.pcm.byteLength);
  });
});
