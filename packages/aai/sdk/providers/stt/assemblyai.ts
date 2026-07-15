// Copyright 2025 the AAI authors. MIT license.
/**
 * AssemblyAI Universal-Streaming STT factory — returns a pure descriptor.
 *
 * The descriptor flows through the bundle → server → runtime pipeline
 * without importing the `assemblyai` SDK. The host-side resolver in
 * `host/providers/resolve.ts` turns it into an openable {@link SttOpener}
 * during `createRuntime`.
 */

import type { SttProvider } from "../../providers.ts";

/** Kind tag recognised by the host-side resolver. */
export const ASSEMBLYAI_KIND = "assemblyai" as const;

/** Agent-env variable holding the AssemblyAI API key. */
export const ASSEMBLYAI_API_KEY_ENV = "ASSEMBLYAI_API_KEY";

export interface AssemblyAIOptions {
  /**
   * Streaming speech model. Defaults to `"universal-3.5-pro"` (Universal-3.5
   * Pro Real-Time). The legacy alias `"u3pro-rt"` is still accepted and maps to
   * the SDK's `"u3-rt-pro"`. Arbitrary strings are forwarded to the SDK
   * unchanged.
   */
  model?: "universal-3.5-pro" | "u3pro-rt" | string;
}

export type AssemblyAIProvider = SttProvider & {
  readonly kind: typeof ASSEMBLYAI_KIND;
  readonly options: AssemblyAIOptions;
};

/**
 * Build an AssemblyAI STT descriptor.
 *
 * The API key is resolved host-side from the agent's env
 * (`ASSEMBLYAI_API_KEY`); there is no factory-time key parameter, so the
 * descriptor stays free of secrets and safe to serialize.
 */
export function assemblyAI(opts: AssemblyAIOptions = {}): AssemblyAIProvider {
  return { kind: ASSEMBLYAI_KIND, options: { ...opts } };
}
