// Copyright 2026 the AAI authors. MIT license.
/**
 * Studio chat LLM selection.
 *
 * Every studio turn runs on the AssemblyAI LLM Gateway **with the caller's
 * own API key** — the same bearer the request authenticated with. The
 * platform holds no LLM credential for the studio at all: a chat turn is
 * billed to the account that asked for it, exactly like the voice sessions
 * of an agent that account publishes (studio-deploy seeds the same key as
 * the published agent's `ASSEMBLYAI_API_KEY`).
 *
 * The *model* (never the key) stays host configuration: `STUDIO_LLM_MODEL`
 * overrides the default, and `STUDIO_LLM_REGION=eu` selects the gateway's
 * EU endpoint (which serves a subset of models — see the region filter).
 * A client can never name a provider or a model; a request-side model field
 * is stripped by the body schema, never honored.
 */

import { ASSEMBLYAI_LLM_API_KEY_ENV, assemblyAI } from "@alexkroman1/aai/llm";
import { resolveLlm } from "@alexkroman1/aai/runtime";
import type { LanguageModel } from "ai";

/**
 * Models on the AssemblyAI LLM Gateway, per
 * https://www.assemblyai.com/docs/llm-gateway/available-models.
 *
 * Order matters: the first entry available in the configured region is the
 * default. `qwen3-next-80b-a3b` leads as the chosen default. Note the gateway
 * documents streamed responses for OpenAI models only; non-OpenAI streams run
 * through the repair wrapper (`_openai-stream-repair.ts` in the SDK), which
 * fills in id-less `tool_calls` deltas and the null `choices` usage frame.
 *
 * **Verify with `node scripts/check-gateway-models.mjs` before adding to this
 * list, and re-run it when a model misbehaves.** The list is ours to maintain
 * and it had gone stale in both directions: `kimi-k2.5` was deprecated (410)
 * and `gemini-3.1-flash-lite-preview` had never existed (400 "model not
 * found"), yet both were offered, and one was reachable via
 * `STUDIO_LLM_MODEL`.
 *
 * Staleness here is expensive because the gateway hides the reason on the
 * path we use. Ask for a dead model WITHOUT `stream` and it says plainly
 * `410 the model version you are trying to access has been deprecated`; ask
 * WITH `stream: true` — which every studio and pipeline turn does — and it
 * answers `500 "something went wrong"`. A 500 is retryable, so the AI SDK
 * tries three times and surfaces "Internal Server Error". From the outside
 * that is indistinguishable from a provider outage: measured, the agent ran
 * for 12 seconds, called no tools, and looked like a lazy model rather than
 * a misconfigured one.
 */
export const ASSEMBLYAI_GATEWAY_MODELS = [
  "qwen3-next-80b-a3b",
  "gpt-5.5",
  // Leads the EU list — Qwen is undocumented for the EU and OpenAI is US-only.
  "claude-sonnet-4-6",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4.1",
  "gpt-oss-120b",
  "gpt-oss-20b",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
  "gemini-3.5-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "qwen3-32B",
] as const;

/**
 * Gateway models the EU endpoint does not serve. Per the docs only Anthropic
 * Claude and most Gemini models are available in the EU; OpenAI is US-only.
 * Qwen is undocumented for the EU and excluded conservatively — hiding a
 * model is harmless, offering one that 404s is not.
 *
 * The `kimi` prefix matches nothing today (the one Kimi model was deprecated)
 * and is kept because the reasoning applies to whichever Kimi model returns.
 */
const GATEWAY_US_ONLY_MODELS: ReadonlySet<string> = new Set(
  ASSEMBLYAI_GATEWAY_MODELS.filter(
    (model) => model.startsWith("gpt-") || model.startsWith("qwen") || model.startsWith("kimi"),
  ),
);

const ASSEMBLYAI_GATEWAY_EU_MODELS = ASSEMBLYAI_GATEWAY_MODELS.filter(
  (model) => !GATEWAY_US_ONLY_MODELS.has(model),
);

function isEuGateway(env: NodeJS.ProcessEnv): boolean {
  return env.STUDIO_LLM_REGION === "eu";
}

/** The gateway model studio turns run on — host override, else region default. */
export function studioLlmModelId(env: NodeJS.ProcessEnv = process.env): string {
  // `||` not `??`: an empty-string env var means "unset".
  const models = isEuGateway(env) ? ASSEMBLYAI_GATEWAY_EU_MODELS : ASSEMBLYAI_GATEWAY_MODELS;
  return env.STUDIO_LLM_MODEL || (models[0] as string);
}

/** Provider/model info for the status endpoint. */
export function studioLlmInfo(env: NodeJS.ProcessEnv = process.env): {
  provider: string;
  model: string;
} {
  return { provider: "assemblyai", model: studioLlmModelId(env) };
}

/**
 * Resolve the live `LanguageModel` for one caller's turn. `apiKey` is the
 * caller's AssemblyAI key (the studio request's bearer) — the only
 * credential the studio LLM ever runs on; host env never reaches the
 * resolver.
 */
export function studioModel(apiKey: string, env: NodeJS.ProcessEnv = process.env): LanguageModel {
  if (!apiKey) throw new Error("Studio LLM requires the caller's AssemblyAI API key");
  const descriptor = assemblyAI({
    model: studioLlmModelId(env),
    ...(isEuGateway(env) ? { region: "eu" as const } : {}),
  });
  return resolveLlm(descriptor, { [ASSEMBLYAI_LLM_API_KEY_ENV]: apiKey });
}
