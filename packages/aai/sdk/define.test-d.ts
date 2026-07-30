// Copyright 2025 the AAI authors. MIT license.
import { expectTypeOf, test } from "vitest";
import { agent } from "./define.ts";
import type { LlmProvider, SttProvider, TtsProvider } from "./providers.ts";
import type { AgentDef } from "./types.ts";

/**
 * Every `AgentDef` field must be declarable through `agent()`.
 *
 * `agent()` re-declares its parameter shape inline and returns `{...defaults,
 * ...def}`, so a field added to `AgentDef` alone still *works* at runtime
 * while being a TS2353 excess-property error for the author — and the CLI and
 * studio bundlers don't typecheck, so nothing catches it. `state` shipped
 * that way.
 */
test("agent() accepts every AgentDef field", () => {
  type MissingFromParam = Exclude<keyof AgentDef, keyof Parameters<typeof agent>[0]>;
  expectTypeOf<MissingFromParam>().toEqualTypeOf<never>();
});

test("agent() accepts allowedHosts and state", () => {
  const def = agent({
    name: "t",
    allowedHosts: ["api.example.com", "*.example.org"],
    state: () => ({ count: 0 }),
  });
  expectTypeOf(def.allowedHosts).toEqualTypeOf<string[] | undefined>();
});

test("agent() accepts stt/llm/tts optional fields", () => {
  const stt = {} as SttProvider;
  const llm = {} as LlmProvider;
  const tts = {} as TtsProvider;
  const def = agent({ name: "t", systemPrompt: "p", stt, llm, tts });
  expectTypeOf(def.stt).toEqualTypeOf<SttProvider | undefined>();
  expectTypeOf(def.llm).toEqualTypeOf<LlmProvider | undefined>();
  expectTypeOf(def.tts).toEqualTypeOf<TtsProvider | undefined>();
});

test("agent() without stt/llm/tts is still legal (s2s mode)", () => {
  const def = agent({ name: "t", systemPrompt: "p" });
  expectTypeOf(def.stt).toEqualTypeOf<SttProvider | undefined>();
  expectTypeOf(def.llm).toEqualTypeOf<LlmProvider | undefined>();
  expectTypeOf(def.tts).toEqualTypeOf<TtsProvider | undefined>();
});
