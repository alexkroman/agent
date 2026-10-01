// Copyright 2026 the AAI authors. MIT license.
/** `fallback([...])` — a failover list as a plain descriptor. */

import { describe, expect, expectTypeOf, it } from "vitest";
import type { LlmProvider, SttProvider, TtsProvider } from "../providers.ts";
import { FALLBACK_KIND, fallback, fallbackMembers, isFallbackDescriptor } from "./fallback.ts";
import { llm } from "./llm/llm.ts";
import { assemblyAIStt } from "./stt/assemblyai.ts";
import { deepgramStt } from "./stt/deepgram.ts";
import { sonioxStt } from "./stt/soniox.ts";
import { cartesiaTts } from "./tts/cartesia.ts";
import { rimeTts } from "./tts/rime.ts";

describe("fallback()", () => {
  it("is a descriptor of kind `fallback` listing its members in order", () => {
    const d = fallback([assemblyAIStt(), deepgramStt({ model: "nova-2" })]);
    expect(d.kind).toBe(FALLBACK_KIND);
    expect(isFallbackDescriptor(d)).toBe(true);
    expect(fallbackMembers(d)).toEqual([
      { kind: "assemblyai", options: {} },
      { kind: "deepgram", options: { model: "nova-2" } },
    ]);
  });

  it("is SERIALIZABLE — it crosses the CLI → server → guest boundary as data", () => {
    const d = fallback([cartesiaTts(), rimeTts()]);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it("carries the primary's `model`, which the LLM descriptor's readers expect", () => {
    const d = fallback([
      llm({ provider: "assemblyai", model: "gpt-5.6-luna" }),
      llm({ provider: "anthropic", model: "claude-sonnet-5" }),
    ]);
    expect(d.options.model).toBe("gpt-5.6-luna");
  });

  it("flattens a nested fallback into one list", () => {
    const inner = fallback([deepgramStt(), sonioxStt()]);
    const d = fallback([assemblyAIStt(), inner]);
    expect(fallbackMembers(d).map((m) => m.kind)).toEqual(["assemblyai", "deepgram", "soniox"]);
  });

  it("copies each member's options rather than capturing them", () => {
    const primary = deepgramStt({ model: "nova-3" });
    const d = fallback([primary, sonioxStt()]);
    (primary.options as { model?: string }).model = "changed";
    expect(fallbackMembers(d)[0]?.options).toEqual({ model: "nova-3" });
  });

  it("refuses fewer than two providers at run time (the tuple type refuses it at compile time)", () => {
    // Through `Reflect.apply`, the way an untyped caller would reach it.
    expect(() => Reflect.apply(fallback, undefined, [[deepgramStt()]])).toThrow(/at least two/);
  });

  it("answers the STAGE of its members, so it fits only that `agent()` field", () => {
    expectTypeOf(fallback([deepgramStt(), sonioxStt()])).toEqualTypeOf<SttProvider>();
    expectTypeOf(fallback([cartesiaTts(), rimeTts()])).toEqualTypeOf<TtsProvider>();
    expectTypeOf(
      fallback([llm({ provider: "openai", model: "a" }), llm({ provider: "groq", model: "b" })]),
    ).toEqualTypeOf<LlmProvider>();
  });
});

describe("fallbackMembers()", () => {
  it("is a guard over a config read off the wire, not a cast", () => {
    expect(fallbackMembers(undefined)).toEqual([]);
    expect(fallbackMembers({ kind: "fallback", options: { providers: "no" } })).toEqual([]);
    expect(
      fallbackMembers({
        kind: "fallback",
        options: { providers: [{ kind: "deepgram", options: {} }, 7, { kind: 1 }] },
      }),
    ).toEqual([{ kind: "deepgram", options: {} }]);
  });
});
