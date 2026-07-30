// Copyright 2025 the AAI authors. MIT license.
import { expectTypeOf, test } from "vitest";
import { agent, type workflow } from "./define.ts";
import type { LlmProvider, SendProvider, SttProvider, TtsProvider } from "./providers.ts";
import type { AgentDef } from "./types.ts";

/**
 * Every `AgentDef` field must be declarable through `agent()` — except
 * `kind`, which is deliberately excluded: `workflow()` is the only
 * author-facing way to make a workflow, so `agent({ kind: "workflow" })`
 * stays a type error instead of a second, defaults-free path to one.
 *
 * `agent()` re-declares its parameter shape inline and returns `{...defaults,
 * ...def}`, so a field added to `AgentDef` alone still *works* at runtime
 * while being a TS2353 excess-property error for the author — and the CLI and
 * studio bundlers don't typecheck, so nothing catches it. `send` and `state`
 * both shipped that way.
 */
test("agent() accepts every AgentDef field except the internal kind marker", () => {
  type MissingFromParam = Exclude<keyof AgentDef, keyof Parameters<typeof agent>[0]>;
  expectTypeOf<MissingFromParam>().toEqualTypeOf<"kind">();
});

test("agent() accepts send and allowedHosts", () => {
  const def = agent({
    name: "t",
    send: {} as SendProvider,
    allowedHosts: ["api.example.com", "*.example.org"],
    state: () => ({ count: 0 }),
  });
  expectTypeOf(def.send).toEqualTypeOf<SendProvider | undefined>();
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

/**
 * A workflow never speaks: `workflow()` deliberately has no `tts`
 * parameter (it always sets the internal `none()` sentinel), so
 * `workflow({ tts })` stays a TS2353 excess-property error rather than a
 * runtime config rejection.
 */
test("workflow() does not accept a tts parameter", () => {
  type WorkflowParamKeys = keyof Parameters<typeof workflow>[0];
  expectTypeOf<Extract<WorkflowParamKeys, "tts">>().toEqualTypeOf<never>();
});
