// Copyright 2025 the AAI authors. MIT license.
/**
 * Cartesia TTS factory — returns a pure descriptor.
 *
 * See `sdk/providers/stt/assemblyai.ts` for the descriptor/opener split;
 * the host-side resolver in `host/providers/resolve.ts` turns this into an
 * openable {@link TtsOpener} during `createRuntime` using the
 * `CARTESIA_API_KEY` from the agent's env.
 */

import type { TtsProvider } from "../../providers.ts";

export const CARTESIA_KIND = "cartesia" as const;

export interface CartesiaOptions {
  /** Cartesia voice ID. Required. */
  voice: string;
  /** Model ID. Defaults to `"sonic-2"`. */
  model?: string;
  /** Spoken language hint. Defaults to `"en"`. */
  language?: string;
}

export type CartesiaProvider = TtsProvider & {
  readonly kind: typeof CARTESIA_KIND;
  readonly options: CartesiaOptions;
};

export function cartesia(opts: CartesiaOptions): CartesiaProvider {
  return { kind: CARTESIA_KIND, options: { ...opts } };
}
