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

import { ASSEMBLYAI_LLM_API_KEY_ENV, assemblyAI, gatewayModelIds } from "@alexkroman1/aai/llm";
import { resolveLlm } from "@alexkroman1/aai/runtime";
import type { LanguageModel } from "ai";

/**
 * The models offered for studio chat, in preference order.
 *
 * The catalog itself is the SDK's {@link ASSEMBLYAI_GATEWAY_MODELS}, which is
 * GENERATED from the gateway's own `/v1/models` in both regions — so this
 * module no longer keeps a list, and cannot drift from the service. Every
 * hand-maintained version did: one carried `kimi-k2.5` (deprecated, 410) and
 * `gemini-3.1-flash-lite-preview` (never existed) while missing nine real
 * models, and EU availability was inferred from id prefixes, which named ten
 * models where the EU endpoint serves six — four of them 404s, under a
 * comment saying offering a 404 was the thing to avoid.
 *
 * `gatewayModelIds` filters to models that can stream AND call tools, which
 * is the only shape a studio turn or a voice pipeline can use; that drops
 * `gpt-oss-20b`/`gpt-oss-120b` (no streaming) and the experimental Qwen (no
 * tools), all three of which the old list offered.
 *
 * Order is ours, not the gateway's: PREFERRED names the defaults we have
 * actually measured, and anything else follows in catalog order. The first
 * entry available in the configured region wins — `gpt-5-mini` in the US,
 * `claude-sonnet-4-6` in the EU, where OpenAI is not served.
 *
 * `gpt-5-mini` leads on measurement, not price list. Over the eleven starter
 * prompts, same window, same everything else: it shipped 11/11 against
 * `qwen3-next-80b-a3b`'s 10/11, and wrote code that compiled first time in
 * 9 runs against qwen's 5. It also does not produce the malformed tool-call
 * JSON that `studio-tool-repair.ts` exists to salvage. Nominally it lists
 * ~1.7x qwen on both token axes, but qwen has NO prompt caching on this
 * gateway while gpt-5-mini reads cache at a tenth of its input price — and
 * an agent loop resends a growing conversation every step, so the sticker
 * comparison is the wrong one. (`gpt-5.5` was cleaner still — 10/11
 * first-try clean, zero repairs — at roughly 20x the price. Not worth it
 * for a turn that already succeeds.)
 *
 * Being listed is a weaker claim than working — the gateway advertises
 * `kimi-k2.5` and answers 410 for it — so `pnpm check:gateway-models` probes
 * as well. That distinction is expensive here: asked for a dead model
 * WITHOUT `stream` the gateway says plainly `410 ... has been deprecated`,
 * but WITH `stream: true`, which every real turn uses, it answers
 * `500 "something went wrong"`. A 500 is retryable, so the AI SDK tries
 * three times and surfaces "Internal Server Error" — indistinguishable from
 * a provider outage. Measured, the agent ran 12 seconds, called no tools,
 * and read as a lazy model rather than a misconfigured one.
 */
const PREFERRED = ["gpt-5-mini", "claude-sonnet-4-6"] as const;

function ordered(ids: readonly string[]): readonly string[] {
  const preferred = PREFERRED.filter((id) => ids.includes(id));
  return [...preferred, ...ids.filter((id) => !preferred.includes(id as never))];
}

export const ASSEMBLYAI_GATEWAY_MODELS = ordered(gatewayModelIds());

const ASSEMBLYAI_GATEWAY_EU_MODELS = ordered(gatewayModelIds({ eu: true }));

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
