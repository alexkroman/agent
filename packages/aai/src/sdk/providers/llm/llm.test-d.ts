// Copyright 2026 the AAI authors. MIT license.
/**
 * Type-level contract for `llm()`: what `provider` narrows, and what the
 * descriptor it returns carries.
 *
 * The narrowing IS the feature — `provider: "assemblyai"` is the one provider
 * whose `providerOptions` this SDK types, and every other provider takes its
 * vendor's own bag verbatim — and a signature is exactly what a runtime spec
 * cannot assert. Negative cases use `.not.toExtend` rather than a
 * expect-error directive, which the escape-hatch ratchet counts.
 */

import { expectTypeOf, test } from "vitest";
import type { LlmDescriptorOptions, LlmProvider } from "../../providers.ts";
import type { AssemblyAILlmProviderOptions, LlmOptions } from "./llm.ts";
import { llm } from "./llm.ts";

test('provider "assemblyai" narrows providerOptions and refuses an unknown region', () => {
  type Opts = NonNullable<LlmOptions<"assemblyai">["providerOptions"]>;
  expectTypeOf<Opts>().toEqualTypeOf<AssemblyAILlmProviderOptions>();
  expectTypeOf<{ region: "eu"; reasoningEffort: "none" }>().toExtend<Opts>();
  expectTypeOf<{ region: "asia" }>().not.toExtend<Opts>();
  expectTypeOf<{ reasoningEffort: "extreme" }>().not.toExtend<Opts>();
});

test("any other provider accepts any providerOptions record", () => {
  type Opts = NonNullable<LlmOptions<"openai">["providerOptions"]>;
  expectTypeOf<Record<string, unknown>>().toExtend<Opts>();
  expectTypeOf<{ reasoningSummary: "auto"; region: "asia" }>().toExtend<Opts>();
  // Inferred from the call, not only from an explicit type argument.
  llm({ provider: "openai", model: "gpt-5.5", providerOptions: { reasoningSummary: "auto" } });
  llm({ provider: "together-ai", model: "m", baseUrl: "https://x.test/v1" });
});

test("the descriptor carries ONE options type, the one the runtime reads", () => {
  const d = llm({ provider: "assemblyai", model: "gpt-5.5" });
  expectTypeOf(d).toEqualTypeOf<LlmProvider>();
  expectTypeOf(d.options).toEqualTypeOf<LlmDescriptorOptions>();
  expectTypeOf(d.options.model).toEqualTypeOf<string>();
  // Not the old `Record<string, unknown>`: a misspelled field is not a field.
  expectTypeOf<LlmDescriptorOptions>().not.toHaveProperty("baseURL");
});
