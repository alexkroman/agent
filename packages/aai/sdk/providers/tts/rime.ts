// Copyright 2026 the AAI authors. MIT license.
/**
 * Rime TTS factory — returns a pure descriptor.
 *
 * See `sdk/providers/stt/assemblyai.ts` for the descriptor/opener split;
 * the host-side resolver in `host/providers/resolve.ts` turns this into an
 * openable `TtsOpener` during `createRuntime` using the
 * `RIME_API_KEY` from the agent's env.
 *
 * Language codes follow ISO 639-3 (three-letter): `"eng"`, `"fra"`, etc.
 * This differs from many APIs that use ISO 639-1 two-letter codes like `"en"`.
 */

import type { TtsProvider } from "../../providers.ts";

/** Kind tag recognised by the host-side resolver. */
export const RIME_KIND = "rime" as const;

/** Agent-env variable holding the Rime API key. */
export const RIME_API_KEY_ENV = "RIME_API_KEY";

/**
 * Default Rime speaker used when callers invoke `rime()` with no `voice`.
 * `cove` is a `mistv2` speaker, matching the default model below — so a
 * bare `rime()` works out of the box for new agents.
 */
export const RIME_DEFAULT_VOICE = "cove";

/** Options for {@link rime}. */
export interface RimeOptions {
  /** Rime speaker ID. Defaults to {@link RIME_DEFAULT_VOICE}. */
  voice?: string;
  /**
   * Rime model ID. Defaults to `"mistv2"` (Rime's most compatible model).
   * Common values: `"mistv2"`, `"arcana"`.
   */
  model?: string;
  /**
   * Spoken language. Uses ISO 639-3 (three-letter codes).
   * Defaults to `"eng"` (English).
   *
   * Note: Rime uses 3-letter codes — use `"eng"` not `"en"`.
   */
  language?: string;
}

/** Descriptor returned by {@link rime}. */
export type RimeProvider = TtsProvider & {
  readonly kind: typeof RIME_KIND;
  readonly options: RimeOptions & { voice: string };
};

/**
 * Build a Rime TTS descriptor for pipeline mode. The API key is resolved
 * host-side from the agent's env (`RIME_API_KEY`).
 */
export function rime(opts: RimeOptions = {}): RimeProvider {
  return {
    kind: RIME_KIND,
    options: { ...opts, voice: opts.voice ?? RIME_DEFAULT_VOICE },
  };
}

/** Synthesis model used when the descriptor names none. */
export const RIME_DEFAULT_MODEL = "mistv2";

/** Synthesis language used when the descriptor names none. */
export const RIME_DEFAULT_LANGUAGE = "eng";

/**
 * The settings this stage will actually run with — the descriptor's own
 * options with every host-side default filled in. Shared by the opener and
 * the runtime's "Session mode resolved" log.
 */
export function resolveRimeSettings(opts: RimeOptions): {
  voice: string;
  model: string;
  language: string;
} {
  return {
    voice: opts.voice ?? RIME_DEFAULT_VOICE,
    model: opts.model ?? RIME_DEFAULT_MODEL,
    language: opts.language ?? RIME_DEFAULT_LANGUAGE,
  };
}
