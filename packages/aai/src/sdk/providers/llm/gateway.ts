// Copyright 2026 the AAI authors. MIT license.
/**
 * Vercel AI Gateway factory — returns a pure descriptor.
 *
 * The [AI Gateway](https://vercel.com/docs/ai-gateway) is a single
 * OpenAI-compatible endpoint fronting hundreds of models from many
 * creators, addressed as `"creator/model"` (e.g. `"zai/glm-4.6"`,
 * `"anthropic/claude-sonnet-4-5"`), behind one `AI_GATEWAY_API_KEY`.
 * Use it to reach models that have no dedicated factory here.
 *
 * The host-side resolver builds a real
 * Vercel AI SDK `LanguageModel` from this descriptor during
 * `createRuntime` via `createGateway` from the `ai` package.
 */

import type { LlmProvider } from "../../providers.ts";
import type { ModelOptions } from "./model-options.ts";

export const GATEWAY_KIND = "gateway" as const;

/** Agent-env variable holding the Vercel AI Gateway API key. */
export const GATEWAY_API_KEY_ENV = "AI_GATEWAY_API_KEY";

/**
 * Options for {@link gatewayLlm}.
 *
 * Empty over {@link ModelOptions} on purpose: this vendor is reached by naming
 * one model id, and every vendor still gets a NAME for its own options so its
 * first vendor-specific setting is an additive field here rather than a re-split
 * of the shared interface across eight call sites.
 */
export interface GatewayLlmOptions extends ModelOptions {}

/**
 * Build a Vercel AI Gateway descriptor.
 *
 * The API key is resolved host-side from the agent's env
 * (`AI_GATEWAY_API_KEY`); there is no factory-time key parameter, so the
 * descriptor stays free of secrets and safe to serialize.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { gatewayLlm } from "@alexkroman1/aai/llm";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   llm: gatewayLlm({ model: "zai/glm-4.6" }),
 * });
 * ```
 *
 * One key, hundreds of models, addressed `"creator/model"`. See
 * https://vercel.com/ai-gateway/models for the list.
 */
export function gatewayLlm(options: GatewayLlmOptions): LlmProvider {
  return { kind: GATEWAY_KIND, options: { ...options } };
}
