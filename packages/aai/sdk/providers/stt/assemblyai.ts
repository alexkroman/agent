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

export interface AssemblyAIOptions {
  /**
   * Streaming speech model. Defaults to `"u3pro-rt"` (Universal-3 Pro
   * Real-Time). Arbitrary strings are forwarded to the SDK unchanged.
   */
  model?: "u3pro-rt" | string;
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
