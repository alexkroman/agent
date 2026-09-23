// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/experimental` — the lane a NEW, UNMEASURED feature ships in
 * before it is promoted onto the contracted surface.
 *
 * **What is here may change or disappear in any release**, a patch included.
 * It is published so an author can try a feature and report what it did, and it
 * is deliberately outside the capability contracts (`NON_AUTHORING_SUBPATHS` in
 * `scripts/_api-contracts-tree.mjs` names it), so moving a signature here costs
 * no epoch and promises nothing.
 *
 * ## The rule this lane exists to enforce
 *
 * **No inert knobs on the contracted surface.** A field that is accepted, typed
 * and documented but that the runtime does not yet honour — or honours without
 * a measurement saying it helps — is worse than no field: an author sets it,
 * nothing fails, and the behaviour they declared never happens. Every one of
 * those the SDK has shipped has had to be removed again at the cost of an epoch.
 * So a feature starts HERE, and is promoted — its names MOVED to the subpath
 * that owns the surface, joining that capability — once it is wired end to end
 * and measured.
 *
 * Promotion is a move, not a copy: nothing is re-exported from both places, so
 * an import from this subpath is always a statement that the author opted into
 * something unfinished.
 *
 * @module experimental
 */

import { omitUndefined } from "./sdk/omit-undefined.ts";
import { llm } from "./sdk/providers/llm/llm.ts";
import type { LlmProvider } from "./sdk/providers.ts";

/** Options for {@link openAICompatibleLlm}. */
export interface OpenAICompatibleLlmOptions {
  /**
   * A name for the provider — the descriptor's `kind`, and what the default
   * key variable is derived from when `apiKeyEnv` is omitted host-side
   * (`<PROVIDER>_API_KEY`). Here it is required anyway, below.
   */
  readonly provider: string;
  /** The model id the endpoint serves. */
  readonly model: string;
  /** The OpenAI-compatible base URL, including the version path (`…/v1`). */
  readonly baseUrl: string;
  /**
   * The env var holding the endpoint's key. REQUIRED here, where `llm()` makes
   * it optional: a provider the runtime has never heard of has no default to
   * fall back to that an author would recognise, so it is named out loud.
   */
  readonly apiKeyEnv: string;
  /**
   * The endpoint's own wire fields (`top_k`, a routing object, …), merged
   * verbatim into each JSON request body. A field the client writes itself
   * (`model`, `messages`, `tools`, `stream`, a set call setting) wins a
   * collision, so an entry here acts as a default.
   */
  readonly providerOptions?: Readonly<Record<string, unknown>>;
}

/**
 * An `llm()` descriptor for an OpenAI-compatible chat-completions endpoint the
 * runtime has no built-in entry for — a self-hosted server, an inference host,
 * a proxy.
 *
 * EXPERIMENTAL: the runtime's fallback for an unregistered provider that names
 * a `baseUrl` is new, and has been exercised by specs rather than measured
 * against real endpoints. This factory is the same descriptor `llm()` builds,
 * with the two fields that fallback depends on made REQUIRED, so a missing one
 * is a compile error instead of a first-session failure.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { openAICompatibleLlm } from "@alexkroman1/aai/experimental";
 *
 * export default agent({
 *   name: "Support",
 *   llm: openAICompatibleLlm({
 *     provider: "my-inference-host",
 *     model: "my-model",
 *     baseUrl: "https://inference.example.com/v1",
 *     apiKeyEnv: "MY_INFERENCE_KEY",
 *   }),
 * });
 * ```
 */
export function openAICompatibleLlm(options: OpenAICompatibleLlmOptions): LlmProvider {
  const { provider, model, baseUrl, apiKeyEnv, providerOptions } = options;
  return llm({ provider, model, baseUrl, apiKeyEnv, ...omitUndefined({ providerOptions }) });
}
