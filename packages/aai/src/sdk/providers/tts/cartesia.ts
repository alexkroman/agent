// Copyright 2025 the AAI authors. MIT license.
/**
 * Cartesia TTS factory — returns a pure descriptor.
 *
 * See `sdk/providers/stt/assemblyai.ts` for the descriptor/opener split;
 * the host-side resolver turns this into an
 * openable `TtsOpener` during `createRuntime` using the
 * `CARTESIA_API_KEY` from the agent's env.
 */

import type { ProviderCredentialOptions, TtsProvider } from "../../providers.ts";

/** Kind tag recognised by the host-side resolver. */
export const CARTESIA_KIND = "cartesia" as const;

/** Agent-env variable holding the Cartesia API key. */
export const CARTESIA_API_KEY_ENV = "CARTESIA_API_KEY";

/**
 * Default voice used when callers invoke `cartesiaTts()` with no `voice`. This
 * is the same voice the example templates ship with, so a bare `cartesiaTts()`
 * works out of the box for new agents.
 */
export const CARTESIA_DEFAULT_VOICE = "f786b574-daa5-4673-aa0c-cbe3e8534c02";

/** Options for {@link cartesiaTts}. */
export interface CartesiaTtsOptions extends ProviderCredentialOptions {
  /** Cartesia voice ID. Defaults to {@link CARTESIA_DEFAULT_VOICE}. */
  voice?: string;
  /** Model ID. Defaults to `"sonic-2"`. */
  model?: string;
  /** Spoken language hint. Defaults to `"en"`. */
  language?: string;
}

/**
 * Build a Cartesia TTS descriptor for pipeline mode. The API key is resolved
 * host-side from the agent's env (`CARTESIA_API_KEY`).
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { CARTESIA_DEFAULT_VOICE, cartesiaTts } from "@alexkroman1/aai/tts";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   tts: cartesiaTts({ voice: CARTESIA_DEFAULT_VOICE, model: "sonic-3" }),
 * });
 * ```
 */
export function cartesiaTts(options: CartesiaTtsOptions = {}): TtsProvider {
  return {
    kind: CARTESIA_KIND,
    options: { ...options, voice: options.voice ?? CARTESIA_DEFAULT_VOICE },
  };
}

/** Synthesis model used when the descriptor names none. */
export const CARTESIA_DEFAULT_MODEL = "sonic-2";

/** Synthesis language used when the descriptor names none. */
export const CARTESIA_DEFAULT_LANGUAGE = "en";

/**
 * The settings this stage will actually run with — the descriptor's own
 * options with every host-side default filled in. Shared by the opener and
 * the runtime's "Session mode resolved" log, so the reported settings are by
 * construction the ones dialled.
 */
export function resolveCartesiaTtsSettings(options: CartesiaTtsOptions): {
  voice: string;
  model: string;
  language: string;
} {
  return {
    voice: options.voice ?? CARTESIA_DEFAULT_VOICE,
    model: options.model ?? CARTESIA_DEFAULT_MODEL,
    language: options.language ?? CARTESIA_DEFAULT_LANGUAGE,
  };
}
