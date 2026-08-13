// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `llm` epoch 1.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import {
  ANTHROPIC_API_KEY_ENV,
  ANTHROPIC_KIND,
  ASSEMBLYAI_GATEWAY_MODELS,
  ASSEMBLYAI_LLM_API_KEY_ENV,
  ASSEMBLYAI_LLM_DEFAULT_MODEL,
  ASSEMBLYAI_LLM_GATEWAY_EU_URL,
  ASSEMBLYAI_LLM_GATEWAY_URL,
  ASSEMBLYAI_LLM_KIND,
  type AssemblyAIGatewayModel,
  type AssemblyAIReasoningEffort,
  anthropic,
  assemblyAILlm,
  GATEWAY_API_KEY_ENV,
  GATEWAY_KIND,
  type GatewayModelInfo,
  GOOGLE_API_KEY_ENV,
  GOOGLE_KIND,
  GROQ_API_KEY_ENV,
  GROQ_KIND,
  gateway,
  gatewayModelIds,
  google,
  groq,
  type LlmProvider,
  MISTRAL_API_KEY_ENV,
  MISTRAL_KIND,
  mistral,
  OPENAI_API_KEY_ENV,
  OPENAI_KIND,
  OPENROUTER_API_KEY_ENV,
  OPENROUTER_BASE_URL,
  OPENROUTER_KIND,
  openai,
  openrouter,
  XAI_API_KEY_ENV,
  XAI_KIND,
  xai,
} from "../../../sdk/providers/llm-barrel.ts";

/** Every vendor factory, each taking a model id. */
export const providers: LlmProvider[] = [
  anthropic({ model: "claude-sonnet-5" }),
  openai({ model: "gpt-5.5" }),
  google({ model: "gemini-2.5-flash" }),
  mistral({ model: "mistral-large-latest" }),
  xai({ model: "grok-4" }),
  groq({ model: "llama-3.3-70b-versatile" }),
  openrouter({ model: "meta-llama/llama-3.3-70b-instruct" }),
  gateway({ model: "zai/glm-4.6" }),
];

/** The AssemblyAI gateway, including the reasoning knob and region select. */
export const model: AssemblyAIGatewayModel | (string & Record<never, never>) =
  ASSEMBLYAI_LLM_DEFAULT_MODEL;
export const effort: AssemblyAIReasoningEffort = "none";
export const assemblyai = assemblyAILlm({
  model,
  reasoningEffort: effort,
  region: "us",
  apiKeyEnv: ASSEMBLYAI_LLM_API_KEY_ENV,
});
export const explicitGateway = assemblyAILlm({ gatewayUrl: ASSEMBLYAI_LLM_GATEWAY_URL });
export const euGateway = assemblyAILlm({ gatewayUrl: ASSEMBLYAI_LLM_GATEWAY_EU_URL });

/** The generated catalog is keyed by model id, and its ids are listable. */
export const catalog: Record<string, GatewayModelInfo> = ASSEMBLYAI_GATEWAY_MODELS;
export const defaultModelInfo: GatewayModelInfo | undefined =
  ASSEMBLYAI_GATEWAY_MODELS[ASSEMBLYAI_LLM_DEFAULT_MODEL];
export const usIds: readonly string[] = gatewayModelIds();
export const euIds: readonly string[] = gatewayModelIds({ eu: true });

export const kinds: string[] = [
  ANTHROPIC_KIND,
  ASSEMBLYAI_LLM_KIND,
  GATEWAY_KIND,
  GOOGLE_KIND,
  GROQ_KIND,
  MISTRAL_KIND,
  OPENAI_KIND,
  OPENROUTER_KIND,
  XAI_KIND,
];

export const keyEnvVars: string[] = [
  ANTHROPIC_API_KEY_ENV,
  ASSEMBLYAI_LLM_API_KEY_ENV,
  GATEWAY_API_KEY_ENV,
  GOOGLE_API_KEY_ENV,
  GROQ_API_KEY_ENV,
  MISTRAL_API_KEY_ENV,
  OPENAI_API_KEY_ENV,
  OPENROUTER_API_KEY_ENV,
  XAI_API_KEY_ENV,
];

export const openrouterBase: string = OPENROUTER_BASE_URL;
