// Copyright 2025 the AAI authors. MIT license.
/**
 * Anthropic LLM factory — returns a pure descriptor.
 *
 * Users call this in place of importing from `@ai-sdk/anthropic` directly,
 * so agent bundles don't drag the Anthropic SDK into the guest sandbox
 * (which has no `--allow-env` permission and would crash on the SDK's
 * eager `ANTHROPIC_BASE_URL` read).
 *
 * The host-side resolver builds a real
 * Vercel AI SDK `LanguageModel` from this descriptor during
 * `createRuntime`, using `ANTHROPIC_API_KEY` from the agent's env.
 */

import type { LlmProvider } from "../../providers.ts";
import type { ModelOptions } from "./model-options.ts";

export const ANTHROPIC_KIND = "anthropic" as const;

/** Agent-env variable holding the Anthropic API key. */
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

/**
 * Build an Anthropic (Claude) LLM descriptor for pipeline mode. The API key
 * is resolved host-side from the agent's env (`ANTHROPIC_API_KEY`).
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { anthropic } from "@alexkroman1/aai/llm";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   llm: anthropic({ model: "claude-sonnet-5" }),
 * });
 * ```
 */
export function anthropic(opts: ModelOptions): LlmProvider {
  return { kind: ANTHROPIC_KIND, options: { ...opts } };
}
