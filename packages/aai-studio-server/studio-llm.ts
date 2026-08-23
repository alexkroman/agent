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

import { gatewayModelIds } from "@alexkroman1/aai/host-internal";

/**
 * The models offered for studio chat, in preference order.
 *
 * The catalog itself is the SDK's `ASSEMBLYAI_GATEWAY_MODELS`, which is
 * GENERATED from the gateway's own `/v1/models` in both regions — so this
 * module no longer keeps a list, and cannot drift from the service.
 * This is an ORDERED LIST OF IDS derived from it, which is why it does not
 * share that name: two same-named exports of different types, one a
 * capability map and one a `string[]`, is a collision a reader resolves by
 * checking the import line. Every
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
 * entry available in the configured region wins — `gpt-5.5` in the US,
 * `claude-sonnet-4-6` in the EU, where OpenAI is not served.
 *
 * `gpt-5.5` leads on measurement, not price list. Over the eleven starter
 * prompts, same window, same everything else: it shipped 10/11 first-try
 * clean with zero repair rounds — it never produces the malformed tool-call
 * JSON that the SDK’s tool-call repair exists to salvage. `gpt-5-mini` (the
 * previous default, kept second) shipped 11/11 with 9/11 compiling first
 * time at roughly a twentieth of the price; the price is accepted here for
 * the cleaner agentic behavior. (`qwen3-next-80b-a3b`, the default before
 * that, shipped 10/11 with only 5 first-try compiles — and has NO prompt
 * caching on this gateway, so its sticker price undercounts what an agent
 * loop resending a growing conversation actually pays.)
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
const PREFERRED = ["gpt-5.5", "gpt-5-mini", "claude-sonnet-4-6"] as const;

function ordered(ids: readonly string[]): readonly string[] {
  const preferred: readonly string[] = PREFERRED.filter((id) => ids.includes(id));
  return [...preferred, ...ids.filter((id) => !preferred.includes(id))];
}

export const STUDIO_LLM_MODELS = ordered(gatewayModelIds());

const STUDIO_LLM_EU_MODELS = ordered(gatewayModelIds({ eu: true }));

function isEuGateway(env: NodeJS.ProcessEnv): boolean {
  return env.STUDIO_LLM_REGION === "eu";
}

/** The gateway model studio turns run on — host override, else region default. */
export function studioLlmModelId(env: NodeJS.ProcessEnv = process.env): string {
  // `||` not `??`: an empty-string env var means "unset".
  const models = isEuGateway(env) ? STUDIO_LLM_EU_MODELS : STUDIO_LLM_MODELS;
  return env.STUDIO_LLM_MODEL || (models[0] as string);
}

/** Provider/model info for the status endpoint. */
export function studioLlmInfo(env: NodeJS.ProcessEnv = process.env): {
  provider: string;
  model: string;
} {
  return { provider: "assemblyai", model: studioLlmModelId(env) };
}
