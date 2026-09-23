// Copyright 2026 the AAI authors. MIT license.
/**
 * The AssemblyAI LLM Gateway half of `llm()` — the one provider this SDK
 * DEFAULTS, and so the one whose model id and reasoning switch are this
 * package's to decide.
 *
 * The [LLM Gateway](https://www.assemblyai.com/docs/llm-gateway) is an
 * OpenAI-compatible chat-completions API that fronts 25+ models behind a
 * single endpoint and the same `ASSEMBLYAI_API_KEY` used for AssemblyAI STT.
 * The host-side resolver builds a real Vercel AI SDK `LanguageModel` from an
 * `llm({ provider: "assemblyai", ... })` descriptor during `createRuntime`.
 *
 * Only {@link ASSEMBLYAI_LLM_DEFAULT_MODEL} and
 * {@link AssemblyAIReasoningEffort} are published (on
 * `@alexkroman1/aai/llm`). The kind, the env-var name and the two gateway
 * endpoints are on `@alexkroman1/aai/host-internal`: an author never types one
 * (`region` and `baseUrl` pick the endpoint), and the readers are the host
 * resolver and `stepGenerate`, which dials the gateway itself.
 */

import { isKnown } from "../../is-known.ts";
import { omitUndefined } from "../../omit-undefined.ts";
import type { AssemblyAIGatewayModel, AssemblyAILlmProviderOptions } from "./llm.ts";

/** Kind tag recognised by the host-side resolver. */
export const ASSEMBLYAI_LLM_KIND = "assemblyai";

/** Agent-env variable holding the AssemblyAI API key (same key as AssemblyAI STT). */
export const ASSEMBLYAI_LLM_API_KEY_ENV: string = "ASSEMBLYAI_API_KEY";

/** US (default) LLM Gateway endpoint. */
export const ASSEMBLYAI_LLM_GATEWAY_URL: string = "https://llm-gateway.assemblyai.com/v1";

/** EU LLM Gateway endpoint — keeps data within the European Union. */
export const ASSEMBLYAI_LLM_GATEWAY_EU_URL: string = "https://llm-gateway.eu.assemblyai.com/v1";

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
 *    `llm({ provider: "assemblyai" })` carries an implicit `reasoningEffort: "none"`.
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
export const ASSEMBLYAI_LLM_DEFAULT_MODEL: AssemblyAIGatewayModel = "gpt-5.6-luna";

/**
 * Reasoning effort forwarded to a gateway model — one of the levels the
 * GPT-5 family accepts, or any other string. The literals include the two off
 * switches: `"none"` (gpt-5.1 and later) and `"minimal"` (the original
 * `gpt-5`/`-mini`/`-nano`, whose lowest setting that is).
 *
 * OPEN, like the model id it is paired with: which levels a model accepts is
 * the gateway's to decide and moves with its models (the Gemini ids refuse
 * `"none"` outright), so a level this release has not heard of is forwarded
 * rather than refused at compile time, and a rejected one is the gateway's 400.
 */
export type AssemblyAIReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | (string & {});

/**
 * Gateway models that REJECT a tool-carrying request unless reasoning is
 * explicitly off — `llm()` defaults `providerOptions.reasoningEffort`
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
 * An EXPLICIT `reasoningEffort` is left alone — same rule as `baseUrl`
 * winning over `region`: naming a value is deliberate. Naming a non-`none`
 * one here is a 500 on the first tool call, which is the author's to make.
 */
const TOOLS_REQUIRE_NO_REASONING: ReadonlySet<string> = new Set([
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);

/**
 * The `reasoningEffort` an AssemblyAI descriptor must carry for `model`: the
 * author's own when they named one, `"none"` for a model in
 * {@link TOOLS_REQUIRE_NO_REASONING}, and nothing otherwise.
 */
export function assemblyAIReasoningEffort(
  model: string,
  explicit: AssemblyAIReasoningEffort | undefined,
): AssemblyAIReasoningEffort | undefined {
  return explicit ?? (TOOLS_REQUIRE_NO_REASONING.has(model) ? "none" : undefined);
}

/** Every gateway region `AssemblyAILlmProviderOptions.region` names. */
const GATEWAY_REGIONS = ["us", "eu"] as const satisfies readonly NonNullable<
  AssemblyAILlmProviderOptions["region"]
>[];

/**
 * Read the two fields an AssemblyAI descriptor's `providerOptions` means, by
 * VALUE rather than by cast.
 *
 * A descriptor crosses the CLI → server → guest boundary as data, so its
 * `providerOptions` is a `Record<string, unknown>` by the time anything reads
 * it, and `llm()`'s narrowing is a claim about the author's source rather than
 * about the bag in hand. A `region` outside its vocabulary is dropped — the
 * same answer as absent (`"us"`) — which is what the runtime did with one
 * before, only now the type says so. `reasoningEffort` is OPEN (see
 * {@link AssemblyAIReasoningEffort}), so any non-empty string is kept and
 * forwarded; a non-string or empty one is dropped, leaving the model's own.
 *
 * @internal
 */
export function readAssemblyAILlmProviderOptions(
  bag: Readonly<Record<string, unknown>> | undefined,
): AssemblyAILlmProviderOptions {
  const region = bag?.region;
  const reasoningEffort = bag?.reasoningEffort;
  return omitUndefined({
    region: typeof region === "string" && isKnown(GATEWAY_REGIONS, region) ? region : undefined,
    reasoningEffort:
      typeof reasoningEffort === "string" && reasoningEffort !== "" ? reasoningEffort : undefined,
  });
}
