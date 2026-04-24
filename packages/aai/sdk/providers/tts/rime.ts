// Copyright 2026 the AAI authors. MIT license.
/**
 * Rime TTS factory — returns a pure descriptor.
 *
 * See `sdk/providers/stt/assemblyai.ts` for the descriptor/opener split;
 * the host-side resolver in `host/providers/resolve.ts` turns this into an
 * openable {@link TtsOpener} during `createRuntime` using the
 * `RIME_API_KEY` from the agent's env.
 *
 * Language codes follow ISO 639-3 (three-letter): `"eng"`, `"fra"`, etc.
 * This differs from many APIs that use ISO 639-1 two-letter codes like `"en"`.
 */

import type { TtsProvider } from "../../providers.ts";

export const RIME_KIND = "rime" as const;

export interface RimeOptions {
  /** Rime speaker ID. Required — Rime has no default speaker. */
  voice: string;
  /**
   * Rime model ID. Defaults to `"mistv2"` (Rime's most compatible model).
   * Common values: `"mistv2"`, `"arcana"`.
   */
  model?: "mistv2" | "arcana" | string;
  /**
   * Spoken language. Uses ISO 639-3 (three-letter codes).
   * Defaults to `"eng"` (English).
   *
   * Note: Rime uses 3-letter codes — use `"eng"` not `"en"`.
   */
  language?: string;
}

export type RimeProvider = TtsProvider & {
  readonly kind: typeof RIME_KIND;
  readonly options: RimeOptions;
};

export function rime(opts: RimeOptions): RimeProvider {
  return { kind: RIME_KIND, options: { ...opts } };
}
