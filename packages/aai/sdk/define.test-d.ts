// Copyright 2025 the AAI authors. MIT license.
import { expectTypeOf, test } from "vitest";
import { agent } from "./define.ts";
import type { LlmProvider, SttProvider, TtsProvider } from "./providers.ts";
import type { AgentDef } from "./types.ts";

/**
 * Every `AgentDef` field must be declarable through `agent()`.
 *
 * `AgentParams` is now *derived* from `AgentDef` (Omit + Partial<Pick>), so
 * this holds by construction — the test stays as a regression lock against
 * anyone reintroducing an inline re-declaration, which is how `state` once
 * shipped as a runtime-working but excess-property-error field (the CLI and
 * studio bundlers don't typecheck user code, so nothing caught it).
 */
test("agent() accepts every AgentDef field", () => {
  type MissingFromParam = Exclude<keyof AgentDef, keyof Parameters<typeof agent>[0]>;
  expectTypeOf<MissingFromParam>().toEqualTypeOf<never>();
});

test("agent() accepts state", () => {
  const def = agent({
    name: "t",
    state: () => ({ count: 0 }),
  });
  expectTypeOf(def.state).toEqualTypeOf<(() => Record<string, unknown>) | undefined>();
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
