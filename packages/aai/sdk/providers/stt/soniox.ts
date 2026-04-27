// Copyright 2026 the AAI authors. MIT license.
/**
 * Soniox real-time STT factory — returns a pure descriptor.
 *
 * The descriptor flows through the bundle → server → runtime pipeline
 * without importing any Soniox client. The host-side resolver in
 * `host/providers/resolve.ts` turns it into an openable {@link SttOpener}
 * during `createRuntime`. The host opener talks to Soniox's real-time
 * WebSocket directly (no Node-targeted SDK is published).
 */

import type { SttProvider } from "../../providers.ts";

/** Kind tag recognised by the host-side resolver. */
export const SONIOX_KIND = "soniox" as const;

export interface SonioxOptions {
  /**
   * Streaming model. Defaults to `"stt-rt-v3"`. Any string is forwarded
   * verbatim so users can opt in to future models.
   */
  model?: string;
  /**
   * Language hints (ISO 639-1 codes) that bias decoding toward the
   * expected languages. Optional; auto-detection is used when omitted.
   * Example: `["en", "es"]`.
   */
  languageHints?: readonly string[];
}

export type SonioxProvider = SttProvider & {
  readonly kind: typeof SONIOX_KIND;
  readonly options: SonioxOptions;
};

/**
 * Build a Soniox STT descriptor.
 *
 * The API key is resolved host-side from the agent's env
 * (`SONIOX_API_KEY`); there is no factory-time key parameter, so the
 * descriptor stays free of secrets and safe to serialize.
 */
export function soniox(opts: SonioxOptions = {}): SonioxProvider {
  return { kind: SONIOX_KIND, options: { ...opts } };
}
