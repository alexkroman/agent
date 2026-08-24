// Copyright 2026 the AAI authors. MIT license.
/**
 * AssemblyAI LLM Gateway factory — returns a pure descriptor.
 *
 * The [LLM Gateway](https://www.assemblyai.com/docs/llm-gateway) is an
 * OpenAI-compatible chat-completions API that fronts 25+ models (Claude,
 * GPT, Gemini, and more) behind a single endpoint and a single
 * `ASSEMBLYAI_API_KEY` — the same key used for AssemblyAI STT.
 *
 * The host-side resolver builds a real
 * Vercel AI SDK `LanguageModel` from this descriptor during
 * `createRuntime`, pointing `@ai-sdk/openai`'s chat-completions client at
 * the gateway base URL.
 *
 * The three AssemblyAI stage factories have distinct names
 * (`assemblyAIStt`, `assemblyAILlm`, `assemblyAITts`), so they can be
 * imported side by side:
 *
 * ```ts
 * import { assemblyAIStt } from "@alexkroman1/aai/stt";
 * import { assemblyAILlm } from "@alexkroman1/aai/llm";
 * import { assemblyAITts } from "@alexkroman1/aai/tts";
 * ```
 */

import { omitUndefined } from "../../omit-undefined.ts";
import type { LlmProvider, ProviderCredentialOptions } from "../../providers.ts";
import type { AssemblyAIGatewayModel } from "./gateway-models.ts";

/** Kind tag recognised by the host-side resolver. */
export const ASSEMBLYAI_LLM_KIND = "assemblyai" as const;

/** Agent-env variable holding the AssemblyAI API key (same key as AssemblyAI STT). */
export const ASSEMBLYAI_LLM_API_KEY_ENV = "ASSEMBLYAI_API_KEY";

/** US (default) LLM Gateway endpoint. */
export const ASSEMBLYAI_LLM_GATEWAY_URL = "https://llm-gateway.assemblyai.com/v1";

/** EU LLM Gateway endpoint — keeps data within the European Union. */
export const ASSEMBLYAI_LLM_GATEWAY_EU_URL = "https://llm-gateway.eu.assemblyai.com/v1";

/**
 * The gateway model to reach for when an agent has no opinion.
 *
 * A default exists because the gateway rejects an unknown model id with a
 * 400 that only appears at the first session — so "invent a plausible model
 * name" is a failure mode with no compile-time or deploy-time guard, and one
 * that a code-generating agent falls into readily.
 *
 * **Changing this id changes more than the model**, because
 * `TOOLS_REQUIRE_NO_REASONING` is keyed by model id: a default inside
 * that set makes the bare `assemblyAILlm()` carry an implicit
 * `reasoningEffort: "none"`, and one outside it carry none at all.
 * `qwen3-next-80b-a3b` is OUTSIDE the set — it accepts a tool-carrying request
 * at any effort, including its own server-side default — so a bare
 * `assemblyAILlm()`, every unset pipeline stage, and the `llm: "<id>"` string
 * shorthand now send no `reasoning_effort` at all. Move the default back to a
 * `gpt-5.6` id and that fill becomes load-bearing again: without it the
 * descriptor 500s on every tool-calling turn.
 *
 * Only the raw factory is affected either way: `assemblyAIPipeline()` passes
 * `"none"` explicitly, for latency rather than for that constraint, so the
 * pipeline behaves identically whichever side of the set the default sits on.
 */
export const ASSEMBLYAI_LLM_DEFAULT_MODEL = "qwen3-next-80b-a3b";

/**
 * Reasoning effort accepted by the gateway's GPT-5-family models, including
 * the two off switches: `"none"` (gpt-5.1 and later) and `"minimal"` (the
 * original `gpt-5`/`-mini`/`-nano`, whose lowest setting that is).
 */
export type AssemblyAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

/**
 * Gateway models that REJECT a tool-carrying request unless reasoning is
 * explicitly off — the factory defaults {@link AssemblyAILlmOptions.reasoningEffort}
 * to `"none"` for these, because on this SDK "unset" is not a usable state.
 *
 * The gateway says so itself: with `tools` present and any non-`none`
 * reasoning effort (including the model's own server-side default, i.e.
 * sending no `reasoning_effort` at all), `/v1/chat/completions` answers
 * *"Function tools with reasoning_effort are not supported for gpt-5.6-luna
 * in /v1/chat/completions. To use function tools, use /v1/responses or set
 * reasoning_effort to 'none'."* Measured 2026-08-06 against the live
 * gateway, 4/4 attempts per model.
 *
 * **It does not surface as that 400 on the path this SDK uses.** The pipeline
 * streams, and streaming converts the same rejection into a bare HTTP 500
 * (`{"message":"something went wrong","code":500}`) with the explanation
 * stripped — so the diagnosis only exists in the non-streaming reply. Any
 * agent that declares a tool — every host-mode session, and every agent that
 * names a built-in now that `DEFAULT_BUILTIN_TOOLS` is empty — would therefore
 * 500 on *every* turn under an unguarded descriptor, and read as a gateway
 * outage rather than a request this SDK built wrong.
 *
 * An EXPLICIT `reasoningEffort` is left alone — same rule as `gatewayUrl`
 * winning over `region`: naming a value is deliberate. Naming a non-`none`
 * one here is a 500 on the first tool call, which is the author's to make.
 */
const TOOLS_REQUIRE_NO_REASONING: ReadonlySet<string> = new Set(["gpt-5.6-luna", "gpt-5.6-terra"]);

/** Options for {@link assemblyAILlm}. */
export interface AssemblyAILlmOptions extends ProviderCredentialOptions {
  /**
   * Gateway model id — {@link AssemblyAIGatewayModel} is the generated union
   * of what `/v1/models` advertises. (The catalog BEHIND it, recording which
   * models stream, call tools and serve the EU region, is
   * `ASSEMBLYAI_GATEWAY_MODELS` on `@alexkroman1/aai/host-internal`; an
   * `agent.ts` picks an id, not a capability row.)
   *
   * Typed against that union so a name the gateway does not carry is caught
   * where it is written, rather than as a 400 at the first session. A plain
   * string is still accepted, because the union is a snapshot of a service
   * that adds models faster than this package releases.
   *
   * Note two listed models (`gpt-oss-20b`, `gpt-oss-120b`) cannot stream, so
   * they cannot drive a voice pipeline at all.
   *
   * Defaults to {@link ASSEMBLYAI_LLM_DEFAULT_MODEL}.
   */
  model?: AssemblyAIGatewayModel | (string & Record<never, never>);
  /**
   * Gateway region. `"eu"` routes through the EU endpoint for data
   * residency — six models at time of writing, per the `eu` flag in the
   * generated catalog. Defaults to `"us"`.
   */
  region?: "us" | "eu";
  /**
   * Gateway base URL, replacing {@link ASSEMBLYAI_LLM_GATEWAY_URL}. Must
   * include the version path (`https://llm-gateway.sandbox000.assemblyai-labs.com/v1`) —
   * the client appends `/chat/completions` and nothing else.
   *
   * Takes precedence over {@link AssemblyAILlmOptions.region}, matching
   * `assemblyAIStt({ streamingUrl })`: naming an endpoint is deliberate and
   * must not be silently overwritten by the residency shorthand. Intended for
   * pre-release/staging clusters; a staging cluster generally issues its own
   * keys, so point every AssemblyAI stage at the same environment or the ones
   * left on production reject the key. Leave unset in production.
   */
  gatewayUrl?: string;
  /**
   * Reasoning effort forwarded to the model as `reasoning_effort`.
   *
   * Unset, no `reasoning_effort` parameter is sent at all — the model runs
   * on its own server-side default. Set `"none"` (gpt-5.1 and later) or
   * `"minimal"` (the original `gpt-5`/`-mini`/`-nano`) to turn reasoning
   * off, e.g. when a voice turn's time-to-first-token matters more than
   * thinking depth.
   *
   * The GPT-5 family is not the only one that accepts it — `qwen3-next-80b-a3b`
   * is a hybrid-thinking model and takes it too (measured 2026-08-06 against
   * the live gateway: `"none"` and `"low"` both return a normal tool-calling
   * completion, streaming included). Models that do not accept it reject a
   * bogus value with a 400 naming the ones they do.
   *
   * **Exception: on the `gpt-5.6` models unset is not a usable state, so the
   * factory fills in `"none"`** — they reject a tool-carrying request at any
   * other effort, and streaming reports that as a bare 500. Setting a
   * non-`none` effort on one of them is honoured, and breaks tool calls. See
   * `TOOLS_REQUIRE_NO_REASONING`. The default model
   * ({@link ASSEMBLYAI_LLM_DEFAULT_MODEL}) is NOT one of them, so the rule
   * above is the live path — a bare `assemblyAILlm()` sends no parameter — and
   * this exception applies only once a `gpt-5.6` id is named.
   */
  reasoningEffort?: AssemblyAIReasoningEffort;
}

/**
 * Build an AssemblyAI LLM Gateway descriptor.
 *
 * The API key is resolved host-side from the agent's env
 * (`ASSEMBLYAI_API_KEY`); there is no factory-time key parameter, so the
 * descriptor stays free of secrets and safe to serialize.
 *
 * Named `assemblyAILlm` (not `assemblyAI`) so the STT
 * (`assemblyAIStt`), LLM, and TTS (`assemblyAITts`) factories can be
 * imported side by side without aliasing.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { assemblyAILlm } from "@alexkroman1/aai/llm";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   llm: assemblyAILlm({ model: "qwen3-next-80b-a3b", reasoningEffort: "none" }),
 * });
 * ```
 *
 * Every option is optional: `assemblyAILlm()` runs
 * {@link ASSEMBLYAI_LLM_DEFAULT_MODEL}. `region: "eu"` selects the EU
 * gateway; {@link AssemblyAIGatewayModel} is the id set.
 */
export function assemblyAILlm(opts: AssemblyAILlmOptions = {}): LlmProvider {
  const model = opts.model ?? ASSEMBLYAI_LLM_DEFAULT_MODEL;
  // See TOOLS_REQUIRE_NO_REASONING: for these models, leaving reasoning on
  // the server-side default is a 500 on every tool-calling turn, so the
  // descriptor carries "none" unless the author named an effort themselves.
  const reasoningEffort =
    opts.reasoningEffort ?? (TOOLS_REQUIRE_NO_REASONING.has(model) ? "none" : undefined);
  return {
    kind: ASSEMBLYAI_LLM_KIND,
    options: {
      ...opts,
      model,
      // `omitUndefined`, not an inverted spread-ternary: this repo has one
      // spelling of an optional field (`guard-invariants` rule 2), and the
      // inverted form is a spelling that rule cannot see.
      ...omitUndefined({ reasoningEffort }),
    },
  };
}
