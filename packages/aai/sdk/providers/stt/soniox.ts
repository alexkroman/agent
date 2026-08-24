// Copyright 2026 the AAI authors. MIT license.
/**
 * Soniox real-time STT factory — returns a pure descriptor.
 *
 * The descriptor flows through the bundle → server → runtime pipeline
 * without importing any Soniox client. The host-side resolver turns it into an
 * openable `SttOpener` during `createRuntime`. The host opener talks to
 * Soniox's real-time WebSocket directly (no Node-targeted SDK is published).
 */

import type { ProviderCredentialOptions, SttProvider } from "../../providers.ts";

/** Kind tag recognised by the host-side resolver. */
export const SONIOX_KIND = "soniox" as const;

/** Agent-env variable holding the Soniox API key. */
export const SONIOX_API_KEY_ENV = "SONIOX_API_KEY";

/** Options for {@link sonioxStt}. */
export interface SonioxSttOptions extends ProviderCredentialOptions {
  /**
   * Streaming model. Defaults to `"stt-rt-v3"`. Any string is forwarded
   * verbatim so users can opt in to future models.
   */
  model?: string;
  /**
   * Language codes (ISO 639-1) that bias decoding toward the expected
   * languages, sent as Soniox's `language_hints`. Example: `["en", "es"]`.
   *
   * **Unset means AUTO-DETECT, not English.** The field is omitted from the
   * request entirely, so Soniox decides — which is the same default
   * `assemblyAIStt` and `elevenlabs` have, and the opposite of `deepgramStt`,
   * whose unset `language` is `"en"`. Pass the codes for a line you know is
   * monolingual, or the handful you expect on one that is not.
   */
  languages?: readonly string[];
}

/**
 * Build a Soniox STT descriptor.
 *
 * The API key is resolved host-side from the agent's env
 * (`SONIOX_API_KEY`); there is no factory-time key parameter, so the
 * descriptor stays free of secrets and safe to serialize.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { sonioxStt } from "@alexkroman1/aai/stt";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   stt: sonioxStt({ model: "stt-rt-v3", languages: ["en", "es"] }),
 * });
 * ```
 *
 * Unset, `languages` is omitted from the request and Soniox
 * auto-detects — which is not the same as English.
 */
export function sonioxStt(opts: SonioxSttOptions = {}): SttProvider {
  return { kind: SONIOX_KIND, options: { ...opts } };
}

/** Streaming model used when the descriptor names none. */
export const SONIOX_DEFAULT_MODEL = "stt-rt-v3";

/**
 * The settings this stage will actually run with — the descriptor's own
 * options with every host-side default filled in. Shared by the opener and
 * the runtime's "Session mode resolved" log.
 */
export function resolveSonioxSttSettings(opts: SonioxSttOptions): {
  model: string;
  languageHints?: readonly string[];
} {
  return {
    model: opts.model ?? SONIOX_DEFAULT_MODEL,
    // Omitted unless set: absent means auto-detect, which is not "English".
    ...(opts.languages && opts.languages.length > 0 ? { languageHints: opts.languages } : {}),
  };
}
