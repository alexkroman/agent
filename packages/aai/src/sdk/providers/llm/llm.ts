// Copyright 2026 the AAI authors. MIT license.
/**
 * `llm()` — ONE descriptor factory for every LLM provider.
 *
 * There used to be nine vendor factories (`anthropicLlm`, `openAILlm`,
 * `cerebrasLlm`, …), each with its own options interface and two of them with
 * an exported base-URL constant. Eight of the nine took exactly one setting —
 * a model id — so the nine names were nine reference pages saying the same
 * thing, and adding a vendor cost a factory, an options type, a contract entry
 * and a registry entry where only the last does anything. The PROVIDER is data
 * now: a string the host resolver dispatches on, exactly as the descriptor's
 * `kind` always was.
 *
 * `provider` is OPEN — {@link KnownLlmProvider} is the autocomplete, and any
 * other string is legal. A name the runtime has no built-in entry for resolves
 * through an OpenAI-compatible chat client when the descriptor carries a
 * `baseUrl` (and an `apiKeyEnv` naming its key), and through whatever a host
 * registered with `registerLlmKind` otherwise. `aai build` / `aai dev` warn
 * about an unknown provider with neither, rather than the type system refusing
 * a vendor this release has not heard of.
 *
 * Base URLs and key-variable names are NOT published: they live in the host
 * resolver's table, beside the client each one configures. `baseUrl` repoints
 * one descriptor; `apiKeyEnv` names the variable its key is read from.
 */

import { omitUndefined } from "../../omit-undefined.ts";
import type { LlmProvider, ProviderCredentialOptions } from "../../providers.ts";
import {
  ASSEMBLYAI_LLM_KIND,
  type AssemblyAIReasoningEffort,
  assemblyAIReasoningEffort,
} from "./assemblyai.ts";
import type { KnownGatewayModel } from "./shared/gateway-models.ts";

/**
 * The providers the runtime resolves with no registration — the autocomplete
 * half of {@link LlmProviderName}.
 *
 * - `"assemblyai"` — AssemblyAI's LLM Gateway, on the `ASSEMBLYAI_API_KEY`
 *   every agent already has. The default stage, and the one a bare model-id
 *   string (`llm: "some-model"`) routes to.
 * - `"gateway"` — the Vercel AI Gateway, `"creator/model"` ids; what an
 *   `llm: "creator/model"` string routes to.
 * - `"openrouter"` — OpenRouter, `"creator/model"` ids.
 * - `"anthropic"`, `"openai"`, `"google"`, `"mistral"`, `"xai"`, `"groq"`,
 *   `"cerebras"` — each vendor's own API and model ids.
 */
export type KnownLlmProvider =
  | "assemblyai"
  | "anthropic"
  | "cerebras"
  | "gateway"
  | "google"
  | "groq"
  | "mistral"
  | "openai"
  | "openrouter"
  | "xai";

/**
 * An LLM provider name — one of {@link KnownLlmProvider}, or any other string.
 *
 * Open on purpose: a provider this release does not know is reached with a
 * `baseUrl` (OpenAI-compatible) or a host's `registerLlmKind`, and a closed
 * union would refuse it at compile time for no reason the runtime shares.
 */
export type LlmProviderName = KnownLlmProvider | (string & {});

/**
 * A model id on AssemblyAI's LLM Gateway — one of {@link KnownGatewayModel},
 * or any other string.
 *
 * The known half is GENERATED from what the gateway advertises, so it is a
 * snapshot of a service that ships models faster than this package releases:
 * a model added upstream after this release is still a legal id, and a
 * regeneration that drops one breaks no author's build. Autocomplete, not a
 * guard.
 */
export type AssemblyAIGatewayModel = KnownGatewayModel | (string & {});

/** `providerOptions` for `provider: "assemblyai"`. */
export type AssemblyAILlmProviderOptions = {
  /**
   * Gateway region. `"eu"` routes through the EU endpoint for data
   * residency — a subset of models, per the generated catalog's `eu` flag.
   * Defaults to `"us"`. A `baseUrl` on the same descriptor wins: naming an
   * endpoint is deliberate and must not be silently overwritten by the
   * residency shorthand.
   */
  readonly region?: "us" | "eu";
  /**
   * Reasoning effort forwarded to the model as `reasoning_effort`.
   *
   * Unset, no parameter is sent and the model runs on its own server-side
   * default — EXCEPT on the gateway models that reject a tool-carrying request
   * unless reasoning is off, where `llm()` fills `"none"`, because there
   * "unset" is a 500 on every turn. An explicit value is always honoured.
   */
  readonly reasoningEffort?: AssemblyAIReasoningEffort;
};

/**
 * Options for {@link llm}.
 *
 * `P` is inferred from `provider`, which is what narrows `model` to the
 * gateway's ids and `providerOptions` to {@link AssemblyAILlmProviderOptions}
 * for `"assemblyai"`. For every other provider `providerOptions` is forwarded
 * verbatim to the AI SDK as that provider's `providerOptions` entry.
 */
export interface LlmOptions<P extends LlmProviderName = LlmProviderName>
  extends ProviderCredentialOptions {
  /** Which provider serves the model — see {@link KnownLlmProvider}. */
  readonly provider: P;
  /**
   * The provider's own model id. `"gateway"` and `"openrouter"` address a
   * model as `"creator/model"`; every other provider takes its bare id.
   *
   * Required: a third-party catalog is not this SDK's to default from, and an
   * id invented on its behalf fails at the first session. The AssemblyAI
   * default is {@link ASSEMBLYAI_LLM_DEFAULT_MODEL}, and an agent that omits
   * `llm` entirely runs it.
   */
  readonly model: P extends "assemblyai" ? AssemblyAIGatewayModel : string;
  /**
   * The endpoint to send requests to, replacing the provider's own. Must
   * include the version path — the client appends `/chat/completions`.
   *
   * On a provider the runtime has no built-in entry for, this is what makes
   * the descriptor resolvable at all: it is dialled as an OpenAI-compatible
   * chat-completions API, keyed by `apiKeyEnv`.
   */
  readonly baseUrl?: string;
  /** Provider-specific settings — see {@link LlmOptions}. */
  readonly providerOptions?: P extends "assemblyai"
    ? AssemblyAILlmProviderOptions
    : Readonly<Record<string, unknown>>;
}

/**
 * Build an LLM descriptor for `agent({ llm })`, `subagent({ llm })` or
 * `ctx.generate({ llm })`.
 *
 * The API key is resolved host-side from the agent's env, by a name the
 * resolver owns per provider (or by `apiKeyEnv`); a descriptor carries no
 * secret, so it stays safe to serialize across the CLI → server → guest
 * boundary.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { llm } from "@alexkroman1/aai/llm";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   llm: llm({ provider: "assemblyai", model: "qwen3-next-80b-a3b" }),
 * });
 * ```
 *
 * A bare model id is the shorthand for the two gateways — `llm: "some-model"`
 * is `llm({ provider: "assemblyai", model: "some-model" })`, and
 * `llm: "creator/model"` is `provider: "gateway"`.
 */
export function llm<const P extends LlmProviderName>(options: LlmOptions<P>): LlmProvider {
  const { provider, model, baseUrl, apiKeyEnv } = options;
  let providerOptions: Readonly<Record<string, unknown>> | undefined = options.providerOptions;
  if (provider === ASSEMBLYAI_LLM_KIND) {
    // See TOOLS_REQUIRE_NO_REASONING: for these models, leaving reasoning on
    // the server-side default is a 500 on every tool-calling turn, so the
    // descriptor carries "none" unless the author named an effort themselves.
    const own = (providerOptions ?? {}) as AssemblyAILlmProviderOptions;
    const reasoningEffort = assemblyAIReasoningEffort(model, own.reasoningEffort);
    const filled = { ...own, ...omitUndefined({ reasoningEffort }) };
    providerOptions = Object.keys(filled).length === 0 ? undefined : filled;
  }
  return {
    kind: provider,
    options: {
      model,
      // `omitUndefined`, not an inverted spread-ternary: this repo has one
      // spelling of an optional field (`guard-invariants` rule 2).
      ...omitUndefined({
        baseUrl,
        apiKeyEnv,
        providerOptions: providerOptions === undefined ? undefined : { ...providerOptions },
      }),
    },
  };
}

/**
 * The names {@link KnownLlmProvider} spells, as a runtime list — what the
 * unknown-provider config warning and the host registry's totality test read.
 *
 * @internal
 */
export const KNOWN_LLM_PROVIDERS = [
  "assemblyai",
  "anthropic",
  "cerebras",
  "gateway",
  "google",
  "groq",
  "mistral",
  "openai",
  "openrouter",
  "xai",
] as const satisfies readonly KnownLlmProvider[];
