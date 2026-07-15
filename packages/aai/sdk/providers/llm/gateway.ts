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
 * The host-side resolver in `host/providers/resolve.ts` builds a real
 * Vercel AI SDK `LanguageModel` from this descriptor during
 * `createRuntime` via `createGateway` from the `ai` package.
 */

import type { LlmProvider } from "../../providers.ts";

export const GATEWAY_KIND = "gateway" as const;

/** Agent-env variable holding the Vercel AI Gateway API key. */
export const GATEWAY_API_KEY_ENV = "AI_GATEWAY_API_KEY";

export interface GatewayOptions {
  /**
   * Gateway model id in `"creator/model"` form, e.g. `"zai/glm-4.6"`,
   * `"anthropic/claude-sonnet-4-5"`, `"openai/gpt-4.1"`. See
   * https://vercel.com/ai-gateway/models for the full list.
   */
  model: string;
}

export type GatewayProvider = LlmProvider & {
  readonly kind: typeof GATEWAY_KIND;
  readonly options: GatewayOptions;
};

/**
 * Build a Vercel AI Gateway descriptor.
 *
 * The API key is resolved host-side from the agent's env
 * (`AI_GATEWAY_API_KEY`); there is no factory-time key parameter, so the
 * descriptor stays free of secrets and safe to serialize.
 */
export function gateway(opts: GatewayOptions): GatewayProvider {
  return { kind: GATEWAY_KIND, options: { ...opts } };
}
