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
import type { AssemblyAIGatewayModel } from "./shared/gateway-models.ts";

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
 * **Changing this id changes more than the model.** Two things are keyed to
 * it, they disagree between model families, and getting either wrong is a
 * silent failure rather than a loud one. The default has moved four times, so
 * what follows is the RULE plus the measured matrix rather than a story about
 * each id:
 *
 * 1. **`TOOLS_REQUIRE_NO_REASONING` membership** decides whether the bare
 *    `assemblyAILlm()` carries an implicit `reasoningEffort: "none"`.
 * 2. **`assemblyAIPipeline()`'s explicit effort** must be a value the id
 *    ACCEPTS. It is not a free tuning knob; a rejected value is a 400, and on
 *    the streaming path this SDK uses it arrives as a bare
 *    `500 {"message":"something went wrong"}` with the explanation stripped.
 *
 * | id | in the set? | `"none"` | lowest accepted | reasoning tokens there |
 * | --- | --- | --- | --- | --- |
 * | `qwen3-next-80b-a3b` | no | **accepted** | `"none"` | **0** |
 * | `gpt-5.6-luna` / `-sol` / `-terra` | **yes** | REQUIRED for tools | `"none"` | 0 |
 * | `gemini-3.7-flash` | no | **400** | `"low"` | ~80 |
 * | `gemini-3.5-flash-lite` | no | **400** | `"minimal"` | 0 |
 *
 * `gpt-5.6-luna` is INSIDE the set, so the bare factory fills `"none"` and
 * that fill is what makes a tool-carrying request work at all on it —
 * measured: `"none"` answers 200, omitting the parameter answers 400
 * non-streaming and a bare 500 streaming. `assemblyAIPipeline()`'s explicit
 * `"none"` therefore merely AGREES with the factory here, and it stays anyway,
 * because it is the only thing turning reasoning off under a default that sits
 * outside the set. **Keep it under every id.**
 *
 * ## This default is the only one MEASURED on answer quality
 *
 * Four ids held it in one day; the benchmark settled it. All on tau2-bench
 * retail, matched per task against the same baseline run:
 *
 * | default | reward | time-to-first-token (p50) |
 * | --- | --- | --- |
 * | **`gpt-5.6-luna`** | **0.463** (108 tasks) / 0.433 +/- 0.090 (0-9 x3) | 832ms |
 * | `gpt-5.6-sol` | 0.19 (16 sims) | 1156-1287ms |
 * | `gemini-3.7-flash` | not run | **2253ms** |
 * | `qwen3-next-80b-a3b` | **0.212** (33 matched tasks) | **664ms** |
 *
 * The qwen row is the decisive one and the reason this constant came back:
 * over 33 tasks run against the identical set, luna scored 0.485 and qwen
 * 0.212, with **11 regressions against 2 improvements** — McNemar two-sided
 * **p = 0.022**. Two unrelated replacement models both landed near 0.19-0.21,
 * so it is the model that moves this number, not one bad id.
 *
 * **Time-to-first-token does not buy it back**, which is the finding worth
 * keeping: qwen is 3.4x faster to first token than the Gemini id and ~2x
 * faster than luna, and it still fails more than twice as often. The failures
 * are not latency-shaped — they are the lookup-recovery procedure in
 * `system-prompt-sections.ts` ("work this list in order") going unfollowed: on
 * a mis-heard name the smaller models re-ask for the same value, which that
 * list forbids as step one, instead of retrying a confusion or an identifier
 * they already hold. Every regression in that run was an
 * authentication-by-name task.
 *
 * So a candidate default needs a tau2 run, not a latency measurement. Do not
 * move this id on price or first-token numbers alone.
 */
export const ASSEMBLYAI_LLM_DEFAULT_MODEL = "gpt-5.6-luna";

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
 * gateway, 4/4 attempts per model; `gpt-5.6-sol` re-measured 5/5 when it
 * became the default, with the identical message naming its own id.
 *
 * **It does not surface as that 400 on the path this SDK uses.** The pipeline
 * streams, and streaming converts the same rejection into a bare HTTP 500
 * (`{"message":"something went wrong","code":500}`) with the explanation
 * stripped — so the diagnosis only exists in the non-streaming reply. Any
 * agent that declares a tool — which is every agent, since
 * `DEFAULT_BUILTIN_TOOLS` carries `think` — would therefore
 * 500 on *every* turn under an unguarded descriptor, and read as a gateway
 * outage rather than a request this SDK built wrong.
 *
 * An EXPLICIT `reasoningEffort` is left alone — same rule as `gatewayUrl`
 * winning over `region`: naming a value is deliberate. Naming a non-`none`
 * one here is a 500 on the first tool call, which is the author's to make.
 */
const TOOLS_REQUIRE_NO_REASONING: ReadonlySet<string> = new Set([
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);

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
export function assemblyAILlm(options: AssemblyAILlmOptions = {}): LlmProvider {
  const model = options.model ?? ASSEMBLYAI_LLM_DEFAULT_MODEL;
  // See TOOLS_REQUIRE_NO_REASONING: for these models, leaving reasoning on
  // the server-side default is a 500 on every tool-calling turn, so the
  // descriptor carries "none" unless the author named an effort themselves.
  const reasoningEffort =
    options.reasoningEffort ?? (TOOLS_REQUIRE_NO_REASONING.has(model) ? "none" : undefined);
  return {
    kind: ASSEMBLYAI_LLM_KIND,
    options: {
      ...options,
      model,
      // `omitUndefined`, not an inverted spread-ternary: this repo has one
      // spelling of an optional field (`guard-invariants` rule 2), and the
      // inverted form is a spelling that rule cannot see.
      ...omitUndefined({ reasoningEffort }),
    },
  };
}
