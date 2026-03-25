// Copyright 2025 the AAI authors. MIT license.

import { DEFAULT_TTS_SAMPLE_RATE } from "./protocol.ts";

/** Structured context attached to log messages. */
export type LogContext = Record<string, unknown>;

/** Structured logger interface. Used by tests to suppress output. */
export type Logger = {
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  debug(msg: string, ctx?: LogContext): void;
};

const log = (fn: (...args: unknown[]) => void) => (msg: string, ctx?: LogContext) =>
  fn(msg, ...(ctx ? [ctx] : []));

export const consoleLogger: Logger = {
  info: log(console.log),
  warn: log(console.warn),
  error: log(console.error),
  debug: log(console.debug),
};

/** S2S endpoint configuration. */
export type S2SConfig = {
  wssUrl: string;
  inputSampleRate: number;
  outputSampleRate: number;
};

/** Default S2S endpoint configuration. */
export const DEFAULT_S2S_CONFIG: S2SConfig = {
  wssUrl: "wss://speech-to-speech.us.assemblyai.com/v1/realtime",
  inputSampleRate: DEFAULT_TTS_SAMPLE_RATE,
  outputSampleRate: DEFAULT_TTS_SAMPLE_RATE,
};
