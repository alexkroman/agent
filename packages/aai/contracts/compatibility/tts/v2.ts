// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:tts` epoch 2.
 *
 * Epoch 2 added `AssemblyAITtsOptions.streamingUrl` — the whole-URL endpoint
 * override a sandbox/pre-release cluster is handed out as, spelled the same way
 * and under the same name as `assemblyAIStt({ streamingUrl })`, so pointing
 * every AssemblyAI stage at one sandbox is one paste per stage. `host`, the bare
 * host it supersedes, is `@deprecated` and still compiles — which is what makes
 * epoch 1 RETAINED rather than dropped, and `./v1.ts` compiles unchanged beside
 * this file.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import {
  ASSEMBLYAI_TTS_API_KEY_ENV,
  ASSEMBLYAI_TTS_DEFAULT_VOICE,
  type AssemblyAITtsProvider,
  type AssemblyAITtsVoice,
  assemblyAITts,
} from "../../../sdk/providers/tts-barrel.ts";

/** Production: no endpoint at all, which is the shape an agent ships with. */
export const production: AssemblyAITtsProvider = assemblyAITts({
  voice: ASSEMBLYAI_TTS_DEFAULT_VOICE,
  language: "en",
});

/**
 * A sandbox cluster: the same service behind another subdomain, reached by the
 * URL it is handed out as — versioned path included, since that is the half the
 * bare-host spelling asked an author to remember.
 */
export const sandbox: AssemblyAITtsProvider = assemblyAITts({
  streamingUrl: "wss://streaming-tts.sandbox025.assemblyai-labs.com/v1/ws/",
  // A sandbox carries its OWN voice catalog, so the name is verified against
  // that cluster rather than against `ASSEMBLYAI_TTS_VOICES` — which is what
  // the `(string & {})` arm of this type is for.
  voice: "scottish_vs" satisfies AssemblyAITtsVoice,
  // And its own keys: one stage on another environment takes another variable.
  apiKeyEnv: "ASSEMBLYAI_SANDBOX_API_KEY",
});

/** Epoch 1's spelling, kept compiling: deprecated is not removed. */
export const viaBareHost: AssemblyAITtsProvider = assemblyAITts({
  host: "streaming-tts.sandbox025.assemblyai-labs.com",
  apiKeyEnv: ASSEMBLYAI_TTS_API_KEY_ENV,
});

export const endpoints: (string | undefined)[] = [
  production.options.streamingUrl,
  sandbox.options.streamingUrl,
  viaBareHost.options.host,
];
