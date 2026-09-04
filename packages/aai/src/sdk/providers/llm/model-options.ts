// Copyright 2026 the AAI authors. MIT license.
/**
 * The options bag every single-setting LLM factory takes.
 *
 * Eight vendors here are reached by naming one model id and nothing else —
 * `anthropicLlm`, `openAILlm`, `googleLlm`, `groqLlm`, `mistralLlm`, `xAILlm`, `openRouterLlm` and
 * `gatewayLlm` — and each used to declare its own `{ model: string }` interface
 * under its own name. Eight byte-identical shapes with no reference outside
 * their own module: they published eight reference pages that said the same
 * thing, and told an author that `AnthropicOptions` and `GoogleOptions`
 * differed somewhere they had not read yet.
 *
 * A vendor that grows a second setting takes its own interface again — the
 * three that already have one (`assemblyAILlm`, and the STT/TTS stages) never
 * shared this. What is common here is the SHAPE, not the vendor.
 */

import type { ProviderCredentialOptions } from "../../providers.ts";

/** Options for an LLM factory whose only setting is which model to run. */
export interface ModelOptions extends ProviderCredentialOptions {
  /**
   * The vendor's own model id, e.g. `"claude-sonnet-5"`, `"gpt-5.5"`,
   * `"gemini-2.5-flash"`. The two aggregator factories (`openRouterLlm`,
   * `gatewayLlm`) address a model as `"creator/model"`; each module's doc names
   * the shape it takes.
   *
   * Required: a third-party vendor's catalog is not this SDK's to default
   * from, and an id invented on its behalf fails at the first session.
   */
  model: string;
}
