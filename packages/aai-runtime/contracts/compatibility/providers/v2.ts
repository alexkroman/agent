// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-2 TEMPLATE: `aai-runtime:providers` — a custom LLM kind.
 *
 * This is the starter as it was written at epoch 2, and it covers what epoch 1
 * could not: `registerLlmKind` and `LlmRegistryEntry` reached no published
 * subpath until this epoch, so a host wiring a model the SDK does not ship had
 * the registry's READER (`resolveLlm`) and no way to write to it. The SPEECH
 * half is unchanged — `v1.ts` beside this file is still the starter for a
 * matched STT + TTS stage pair, and still compiles.
 *
 * Copy the file into your host, edit the points marked `// ←`, and call
 * {@link installCustomLlm} where you build the agent's config.
 *
 * **FROZEN.** This file must keep compiling against current source for as long
 * as epoch 2 is supported — a compile error here is the finding, not something
 * to edit away. The way to change this API is a NEW epoch carrying a new
 * template, never an edit to this one. (Imports are relative because the
 * package cannot resolve itself by name; in your copy they are
 * `@alexkroman1/aai-runtime`.)
 *
 * **What a registered kind buys you** over building a `LanguageModel` yourself
 * and handing it to the pipeline: the descriptor an agent config carries is
 * plain data that crossed a wire, so the rest of your host — the credential
 * preflight, the host-mode handshake's allow-list, `withHostCredentialFallback`
 * — only ever sees a `{ kind, options }` pair and resolves your model exactly
 * like a shipped one, `envVar` included.
 */

import { createOpenAI } from "@ai-sdk/openai";
// The descriptor type stays on the authoring subpath: a descriptor is what an
// agent config carries. The registry entry below is the host's half.
import type { LlmProvider } from "@alexkroman1/aai/llm";
import type { LanguageModel } from "ai";
import { type LlmRegistryEntry, registerLlmKind, resolveLlm } from "../../../runtime-barrel.ts";

// ---------------------------------------------------------------------------
// Edit points
// ---------------------------------------------------------------------------

/** The kind an LLM descriptor names to select this model. */
export const CUSTOM_LLM_KIND = "custom-llm"; // ← name it after your vendor

/**
 * The credential the runtime resolves BEFORE building the model, and hands to
 * `create` as its first argument.
 *
 * The preflight that checks an agent's credentials before it starts reads
 * exactly this name, so an agent whose env lacks it fails to start rather than
 * failing inside its first turn.
 */
export const CUSTOM_LLM_API_KEY_ENV = "CUSTOM_LLM_API_KEY"; // ←

/** Where the model is served from. */
export const CUSTOM_LLM_BASE_URL = "https://api.your-vendor.example/v1"; // ←

/** The model id used when the agent's descriptor names none. */
export const CUSTOM_LLM_DEFAULT_MODEL = "custom-1"; // ←

/** What this vendor is called in an error message. */
export const CUSTOM_LLM_LABEL = "Your Vendor"; // ←

// ---------------------------------------------------------------------------
// The one seam that touches your vendor
// ---------------------------------------------------------------------------

/**
 * `create` is handed the DESCRIPTOR, whose `options` are a serializable record —
 * the agent config crossed a wire to get here — so read your own options back
 * out with a narrowing rather than a cast.
 */
function modelOf(descriptor: LlmProvider): string {
  const model = descriptor.options.model;
  return typeof model === "string" && model !== "" ? model : CUSTOM_LLM_DEFAULT_MODEL;
}

/**
 * ← Build the model.
 *
 * An OpenAI-compatible `/chat/completions` endpoint is the common case and the
 * cheapest to write: point `@ai-sdk/openai` at your base URL and use `.chat()`,
 * because the provider's default callable targets the Responses API instead.
 * A vendor with its own `@ai-sdk/*` adapter substitutes it here and nothing
 * else in this file changes.
 *
 * Do not read `process.env` for the key. The runtime resolved it out of the
 * AGENT's env and handed it in — reaching past that is how a deployed agent
 * comes to depend on a host variable that does not exist in its sandbox.
 */
export function createCustomModel(apiKey: string, descriptor: LlmProvider): LanguageModel {
  return createOpenAI({
    apiKey,
    baseURL: CUSTOM_LLM_BASE_URL,
    name: CUSTOM_LLM_KIND,
  }).chat(modelOf(descriptor));
}

/** The registry entry: the credential to resolve, the label, and the factory. */
export function customLlmEntry(): LlmRegistryEntry {
  return {
    envVar: CUSTOM_LLM_API_KEY_ENV,
    label: CUSTOM_LLM_LABEL,
    create: createCustomModel,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** The descriptor an agent config names, and the env that resolves it. */
export type CustomLlmStage = {
  readonly llm: LlmProvider;
  /** Merge into the runtime's env. */
  readonly env: Record<string, string>;
  /** Unregister the kind. */
  release(): void;
};

/**
 * Install the kind and hand back what an agent config names.
 *
 * `suffix` keeps the kind unique per install, for the reason the speech
 * template gives: the registry is process-global and a session can outlive
 * whatever installed it, so two concurrent installs sharing a kind serve each
 * other's traffic. Call `release()` when the last session using it is gone — an
 * unregister is not optional.
 */
export function installCustomLlm(suffix: string, apiKey: string, model?: string): CustomLlmStage {
  const kind = `${CUSTOM_LLM_KIND}-${suffix}`;
  const release = registerLlmKind(kind, customLlmEntry());
  return {
    llm: { kind, options: model === undefined ? {} : { model } },
    env: { [CUSTOM_LLM_API_KEY_ENV]: apiKey },
    release,
  };
}

/**
 * Resolve the descriptor the way the runtime will, for a startup smoke check.
 *
 * Worth doing before serving: `resolveLlm` throws on a missing credential at
 * CONSTRUCTION, which is a clearer failure than the same key going missing
 * several seconds into somebody's first turn.
 */
export function resolveCustomLlm(stage: CustomLlmStage): LanguageModel {
  return resolveLlm(stage.llm, stage.env);
}
