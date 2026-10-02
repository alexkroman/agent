// Copyright 2026 the AAI authors. MIT license.
/**
 * The pipeline fuzz's oracles, each tripped once on purpose. A property whose
 * oracle can never flag is a green run that proves nothing, so the cases here
 * are the counterexamples each one exists to catch.
 */

import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel, createFakeTtsProvider } from "../_pipeline-test-fakes.ts";
import {
  checkPrompt,
  checkReplyIntegrity,
  createCallbacks,
  GREETING,
  instrumentLlm,
  type Monitor,
  norm,
  promptProblems,
  type ReplyRecord,
  trackStreamLifetime,
} from "./_pipeline-fuzz-model.ts";

/** A monitor that records what it was told. */
function monitor(): Monitor & { flags: string[]; hits: string[] } {
  const flags: string[] = [];
  const hits: string[] = [];
  const mon: Monitor & { flags: string[]; hits: string[] } = {
    flags,
    hits,
    current: null,
    stopped: false,
    declaredDead: null,
    toolInFlight: 0,
    audioTotal: 0,
    liveStreams: 0,
    maxLiveStreams: 0,
    consumedSteps: 0,
    speculating: false,
    ttsAccountedFor: null,
    flag: (what) => flags.push(what),
    hit: (key) => hits.push(key),
    disturb: () => {
      if (mon.current !== null) mon.current.disturbed = true;
    },
  };
  return mon;
}

function reply(overrides: Partial<ReplyRecord> = {}): ReplyRecord {
  return {
    id: "r1",
    ttsOffset: 0,
    expected: "",
    disturbed: false,
    audioChunks: 0,
    failed: false,
    done: false,
    ...overrides,
  };
}

describe("norm", () => {
  test("collapses and trims whitespace", () => {
    expect(norm("  a \n b\t\tc ")).toBe("a b c");
  });
});

describe("promptProblems", () => {
  test("a well-formed prompt has none", () => {
    expect(
      promptProblems([
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1" }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "c1" }] },
      ]),
    ).toEqual([]);
  });

  test("names a non-array prompt, empty content, and every pairing fault", () => {
    expect(promptProblems("nope")).toEqual(["prompt is not an array"]);
    expect(
      promptProblems([
        { role: "user", content: "" },
        { role: "assistant", content: [] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "early" }] },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "early" }] },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "dangling" }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "orphan" }] },
      ]),
    ).toEqual([
      "msg[0] role=user empty string content",
      "msg[1] role=assistant empty content array",
      "tool-result early precedes its call",
      "dangling tool-call dangling (msg[4])",
      "orphan tool-result orphan (msg[5])",
    ]);
  });
});

describe("trackStreamLifetime", () => {
  test("settles once when the stream ends, and hands the SDK every chunk", async () => {
    let settled = 0;
    const source = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
        controller.close();
      },
    });
    const forSdk = trackStreamLifetime(source, undefined, () => settled++);
    const seen: number[] = [];
    for await (const chunk of forSdk) seen.push(chunk);
    await vi.waitFor(() => expect(settled).toBe(1));
    expect(seen).toEqual([1, 2]);
  });

  test("settles on abort even when the stream never ends", () => {
    let settled = 0;
    const controller = new AbortController();
    trackStreamLifetime(new ReadableStream(), controller.signal, () => settled++);
    controller.abort();
    controller.abort();
    expect(settled).toBe(1);
  });
});

describe("checkReplyIntegrity", () => {
  test("flags a reply whose spoken text differs from what the model produced", async () => {
    const tts = createFakeTtsProvider();
    const session = await tts.open({
      sampleRate: 24_000,
      apiKey: "k",
      signal: AbortSignal.any([]),
    });
    session.sendText("hello ");
    session.sendText("world");
    const mon = monitor();
    checkReplyIntegrity(reply({ expected: "hello  world" }), tts, mon);
    expect(mon.flags).toEqual([]);
    expect(mon.hits).toEqual(["replyIntegrityChecked"]);

    checkReplyIntegrity(reply({ expected: "goodbye" }), tts, mon);
    expect(mon.flags[0]).toMatch(/spoke "hello world" but the model produced "goodbye"/);
  });

  test("makes no claim about a disturbed or failed reply, or under speculation", () => {
    const tts = createFakeTtsProvider();
    const mon = monitor();
    checkReplyIntegrity(reply({ expected: "x", disturbed: true }), tts, mon);
    checkReplyIntegrity(reply({ expected: "x", failed: true }), tts, mon);
    mon.speculating = true;
    checkReplyIntegrity(reply({ expected: "x" }), tts, mon);
    expect(mon.flags).toEqual([]);
  });
});

describe("createCallbacks", () => {
  test("a greeting reply expects the greeting, and its completion runs the integrity check", () => {
    const mon = monitor();
    const callbacks = createCallbacks(mon, createFakeTtsProvider());
    callbacks.onReplyStarted("pipeline-greeting-1");
    expect(mon.current?.expected).toBe(GREETING);
    callbacks.report({ type: "reply.completed" });
    expect(mon.current?.done).toBe(true);
    // Nothing was synthesized, so the integrity oracle flags the silent greeting.
    expect(mon.flags).toEqual([expect.stringContaining('spoke ""')]);
  });

  test("flags a duplicate reply id, a completion with nothing started, and stray audio", () => {
    const mon = monitor();
    const callbacks = createCallbacks(mon, createFakeTtsProvider());
    callbacks.report({ type: "reply.completed" });
    callbacks.onAudioChunk?.(new Uint8Array(2));
    callbacks.onReplyStarted("r1");
    callbacks.onReplyStarted("r1");
    expect(mon.flags).toEqual([
      "reply.completed without a matching reply start",
      "reply.completed with no reply in flight",
      "audio chunk forwarded before any reply started",
      "duplicate reply id r1",
    ]);
  });

  test("anything after stop() or a fatal error is flagged", () => {
    const mon = monitor();
    const callbacks = createCallbacks(mon, createFakeTtsProvider());
    callbacks.report({ type: "error.reported", code: "stt", message: "dead", fatal: true });
    expect(mon.declaredDead).toBe("stt");
    mon.stopped = true;
    callbacks.onReplyStarted("r2");
    expect(mon.flags).toEqual([
      "reply start fired after stop() resolved",
      "reply start fired after a fatal [stt]",
    ]);
  });

  test("a non-fatal llm error marks the reply failed rather than the session dead", () => {
    const mon = monitor();
    const callbacks = createCallbacks(mon, createFakeTtsProvider());
    callbacks.onReplyStarted("r1");
    callbacks.report({ type: "error.reported", code: "llm", message: "x", fatal: false });
    expect(mon.declaredDead).toBeNull();
    expect(mon.current?.failed).toBe(true);
    expect(mon.hits).toContain("nonFatal:llm");
  });
});

describe("checkPrompt", () => {
  test("flags an interruption recorded in a session that never played audio", () => {
    const mon = monitor();
    checkPrompt([{ role: "assistant", content: "hi [interrupted]" }], mon);
    expect(mon.flags).toHaveLength(1);
    mon.audioTotal = 1;
    checkPrompt([{ role: "tool", content: [] }], mon);
    expect(mon.flags).toHaveLength(1);
    expect(mon.hits).toEqual(["llmRequestWithTool"]);
  });
});

describe("instrumentLlm", () => {
  test("refuses on the cycled refusal schedule and counts every live stream", async () => {
    const llm = createFakeLanguageModel({ steps: [[{ type: "text", text: "a" }]] });
    const mon = monitor();
    mon.current = reply();
    instrumentLlm(llm, ["step zero text"], mon, [true, false]);
    if (typeof llm === "string" || llm.specificationVersion !== "v3") throw new Error("v3 only");

    await expect(llm.doStream({ prompt: [] })).rejects.toThrow(/refused/);
    const { stream } = await llm.doStream({ prompt: [] });
    expect(mon.liveStreams).toBe(1);
    for await (const _ of stream) {
      // drain
    }
    await vi.waitFor(() => expect(mon.liveStreams).toBe(0));
    expect(mon.maxLiveStreams).toBe(1);
    expect(mon.current.expected).toBe("step zero text");
    expect(mon.hits).toEqual(["llmRequest", "llmRefused", "llmRequest"]);
  });
});
