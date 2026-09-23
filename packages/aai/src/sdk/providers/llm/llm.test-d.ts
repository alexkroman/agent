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
import type {
  AssemblyAIGatewayModel,
  AssemblyAILlmProviderOptions,
  KnownLlmProvider,
  LlmOptions,
  LlmProviderName,
} from "./llm.ts";
import { type KNOWN_LLM_PROVIDERS, llm } from "./llm.ts";
import type { KnownGatewayModel } from "./shared/gateway-models.ts";

test('provider "assemblyai" narrows providerOptions and refuses an unknown region', () => {
  type Opts = NonNullable<LlmOptions<"assemblyai">["providerOptions"]>;
  expectTypeOf<Opts>().toEqualTypeOf<AssemblyAILlmProviderOptions>();
  expectTypeOf<{ region: "eu"; reasoningEffort: "none" }>().toExtend<Opts>();
  expectTypeOf<{ region: "asia" }>().not.toExtend<Opts>();
  // `reasoningEffort` is OPEN: a level the gateway adds later still compiles.
  expectTypeOf<{ reasoningEffort: "xhigh" }>().toExtend<Opts>();
  expectTypeOf<{ reasoningEffort: 3 }>().not.toExtend<Opts>();
});

test("the open vocabularies spell their literals inline, and the closed halves derive from them", () => {
  // Open: any string is a legal provider / gateway model.
  expectTypeOf<"together-ai">().toExtend<LlmProviderName>();
  expectTypeOf<"a-model-shipped-next-week">().toExtend<AssemblyAIGatewayModel>();
  // The derived closed halves hold the literals and nothing else.
  expectTypeOf<KnownLlmProvider>().toEqualTypeOf<(typeof KNOWN_LLM_PROVIDERS)[number]>();
  expectTypeOf<"together-ai">().not.toExtend<KnownLlmProvider>();
  expectTypeOf<"gpt-5.6-luna">().toExtend<KnownGatewayModel>();
  expectTypeOf<"a-model-shipped-next-week">().not.toExtend<KnownGatewayModel>();
  expectTypeOf<string>().not.toExtend<KnownGatewayModel>();
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
