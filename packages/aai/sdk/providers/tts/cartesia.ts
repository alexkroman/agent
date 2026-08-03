// Copyright 2025 the AAI authors. MIT license.
/**
 * Cartesia TTS factory — returns a pure descriptor.
 *
 * See `sdk/providers/stt/assemblyai.ts` for the descriptor/opener split;
 * the host-side resolver in `host/providers/resolve.ts` turns this into an
 * openable `TtsOpener` during `createRuntime` using the
 * `CARTESIA_API_KEY` from the agent's env.
 */

import type { TtsProvider } from "../../providers.ts";

/** Kind tag recognised by the host-side resolver. */
export const CARTESIA_KIND = "cartesia" as const;

/** Agent-env variable holding the Cartesia API key. */
export const CARTESIA_API_KEY_ENV = "CARTESIA_API_KEY";

/**
 * Default voice used when callers invoke `cartesia()` with no `voice`. This
 * is the same voice the example templates ship with, so a bare `cartesia()`
 * works out of the box for new agents.
 */
export const CARTESIA_DEFAULT_VOICE = "f786b574-daa5-4673-aa0c-cbe3e8534c02";

/** Options for {@link cartesia}. */
export interface CartesiaOptions {
  /** Cartesia voice ID. Defaults to {@link CARTESIA_DEFAULT_VOICE}. */
  voice?: string;
  /** Model ID. Defaults to `"sonic-2"`. */
  model?: string;
  /** Spoken language hint. Defaults to `"en"`. */
  language?: string;
}

/** Descriptor returned by {@link cartesia}. */
export type CartesiaProvider = TtsProvider & {
  readonly kind: typeof CARTESIA_KIND;
  readonly options: CartesiaOptions & { voice: string };
};

/**
 * Build a Cartesia TTS descriptor for pipeline mode. The API key is resolved
 * host-side from the agent's env (`CARTESIA_API_KEY`).
 */
export function cartesia(opts: CartesiaOptions = {}): CartesiaProvider {
  return {
    kind: CARTESIA_KIND,
    options: { ...opts, voice: opts.voice ?? CARTESIA_DEFAULT_VOICE },
  };
}
