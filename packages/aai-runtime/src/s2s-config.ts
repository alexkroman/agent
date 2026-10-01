// Copyright 2025 the AAI authors. MIT license.

/**
 * The {@link S2sConfig} for the Speech-to-Speech endpoint and the audio sample
 * rates every transport reads off it.
 */

import {
  ASSEMBLYAI_S2S_SAMPLE_RATE,
  DEFAULT_STT_SAMPLE_RATE,
  DEFAULT_TTS_SAMPLE_RATE,
} from "@alexkroman1/aai/host-internal";
import type { Logger } from "./logger.ts";

/**
 * Speech-to-Speech (S2S) endpoint configuration.
 *
 * Controls which AssemblyAI real-time WebSocket endpoint to connect to and
 * the audio sample rates for input (microphone → STT) and output (TTS → speaker).
 */
export type S2sConfig = {
  /** The WebSocket URL of the S2S real-time endpoint. */
  wssUrl: string;
  /** Sample rate in Hz for audio sent to STT (microphone capture). */
  inputSampleRate: number;
  /** Sample rate in Hz for TTS audio received from the server. */
  outputSampleRate: number;
};

/**
 * Default S2S endpoint configuration.
 * @internal
 */
export const DEFAULT_S2S_CONFIG: S2sConfig = {
  wssUrl: "wss://agents.assemblyai.com/v1/ws",
  inputSampleRate: DEFAULT_STT_SAMPLE_RATE,
  outputSampleRate: DEFAULT_TTS_SAMPLE_RATE,
};

/**
 * Force an {@link S2sConfig} onto the one sample rate AssemblyAI's Voice Agent
 * API accepts ({@link ASSEMBLYAI_S2S_SAMPLE_RATE}) — call it only when the
 * session will run on that transport.
 *
 * `S2sConfig.inputSampleRate` serves three consumers with three contracts: the
 * pipeline's STT stage (16 kHz is right there, and cheaper), OpenAI Realtime
 * (which honours whatever rate we declare), and this service (which honours
 * nothing and accepts only 24 kHz). One field, three contracts — so the rate
 * cannot be fixed by changing {@link DEFAULT_S2S_CONFIG}, which would move the
 * pipeline's STT to 24 kHz too. It is pinned per transport instead, and the
 * pinned rates are what `buildReadyConfig` advertises, so a client that
 * captures off that frame is correct by construction.
 *
 * **Pinning is necessary and NOT sufficient**: it makes every number in the
 * stack say 24 kHz, but cannot make a client's bytes be 24 kHz, and the service
 * decodes whatever arrives at 24 kHz silently. So a host-mode client that
 * DECLARES a rate this transport cannot honour has its handshake REJECTED
 * rather than silently overridden — see `assertHostRatesSupported` in
 * `server/host-mode.ts`. This function's warn covers the other caller: an
 * operator passing `s2sConfig` to `createRuntime` directly, where there is no
 * handshake to fail.
 *
 * @internal
 */
export function pinAssemblyS2sRates(config: S2sConfig, log?: Logger): S2sConfig {
  const rate = ASSEMBLYAI_S2S_SAMPLE_RATE;
  if (config.inputSampleRate === rate && config.outputSampleRate === rate) return config;
  log?.warn("S2S sample rates pinned to the Voice Agent API's only supported rate", {
    requestedInputSampleRate: config.inputSampleRate,
    requestedOutputSampleRate: config.outputSampleRate,
    sampleRate: rate,
  });
  return { ...config, inputSampleRate: rate, outputSampleRate: rate };
}
