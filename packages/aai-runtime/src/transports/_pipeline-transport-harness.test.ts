// Copyright 2026 the AAI authors. MIT license.
/**
 * The pipeline-transport spec harness: `makeOpts` builds options a transport
 * really accepts, with the defaults a spec relies on stated, and the readers
 * (`spoken`, `llmCalls`, `firstCallArg`) refuse a value they cannot read rather
 * than answering empty.
 */

import { describe, expect, test, vi } from "vitest";
import { createFakeTtsProvider } from "../_pipeline-test-fakes.ts";
import {
  firstCallArg,
  inFlightReplyScript,
  llmCalls,
  makeOpts,
  noopToolSchema,
  spoken,
  useVirtualTime,
} from "./_pipeline-transport-harness.ts";

describe("makeOpts", () => {
  test("defaults the barge-in gate off and lets overrides win", () => {
    const { opts } = makeOpts();
    expect(opts.interruptionMinDurationMs).toBe(0);
    expect(opts.sid).toBe("test-sid");
    expect(makeOpts({ sid: "other" }).opts.sid).toBe("other");
  });

  test("hands back the fakes it wired in, or the ones a spec passed", () => {
    const tts = createFakeTtsProvider();
    const built = makeOpts({}, { tts });
    expect(built.tts).toBe(tts);
    expect(built.opts.tts).toBe(tts);
    expect(built.opts.stt).toBe(built.stt);
    expect(built.opts.callbacks).toBe(built.callbacks);
  });

  test("the default executeTool rejects, so a spec that needs one must say so", async () => {
    const { opts } = makeOpts();
    await expect(opts.executeTool("lookup", {}, "s", [])).rejects.toThrow(/No executeTool/);
  });
});

describe("the readers", () => {
  test("`spoken` joins the last TTS session's text, and is empty before any", async () => {
    const tts = createFakeTtsProvider();
    expect(spoken(tts)).toBe("");
    const session = await tts.open({
      sampleRate: 24_000,
      apiKey: "k",
      signal: AbortSignal.any([]),
    });
    session.sendText("Hello ");
    session.sendText("there");
    expect(spoken(tts)).toBe("Hello there");
  });

  test("`llmCalls` reads the fake model's call log, and refuses a model id", () => {
    const { opts } = makeOpts();
    expect(llmCalls(opts).calls).toEqual([]);
    expect(() => llmCalls({ ...opts, llm: "openai/gpt-4o" })).toThrow(
      /not a createFakeLanguageModel/,
    );
  });

  test("`firstCallArg` reads a spy's first argument, and names a spy never called", () => {
    const spy = vi.fn();
    expect(() => firstCallArg(spy)).toThrow(/never invoked/);
    spy("first", "ignored");
    spy("second");
    expect(firstCallArg<string>(spy)).toBe("first");
  });

  test("the fixtures are the shapes their callers rely on", () => {
    const script = inFlightReplyScript();
    expect(script).toHaveLength(100);
    expect(script[0]).toEqual({ type: "text", text: "chunk0 " });
    expect(noopToolSchema.name).toBe("lookup");
  });
});

describe("useVirtualTime", () => {
  useVirtualTime();

  test("installs fake timers for every case in the file", async () => {
    const fired = vi.fn();
    setTimeout(fired, 10_000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fired).toHaveBeenCalledTimes(1);
  });
});
