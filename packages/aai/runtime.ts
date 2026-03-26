// Copyright 2025 the AAI authors. MIT license.

/**
 * Runtime dependencies injected into the session pipeline.
 *
 * Defines the {@link Logger} interface, a default {@link consoleLogger},
 * and the {@link S2SConfig} for Speech-to-Speech endpoint configuration.
 */

import { DEFAULT_STT_SAMPLE_RATE, DEFAULT_TTS_SAMPLE_RATE } from "./protocol.ts";

/** Structured context attached to log messages. */
export type LogContext = Record<string, unknown>;

/**
 * Structured logger interface. Used by tests to suppress output and by
 * consumers to plug in custom logging backends.
 *
 * @example
 * ```ts
 * const myLogger: Logger = {
 *   info: (msg, ctx) => myBackend.log("info", msg, ctx),
 *   warn: (msg, ctx) => myBackend.log("warn", msg, ctx),
 *   error: (msg, ctx) => myBackend.log("error", msg, ctx),
 *   debug: (msg, ctx) => myBackend.log("debug", msg, ctx),
 * };
 * createServer({ agent, logger: myLogger });
 * ```
 */
export type Logger = {
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  debug(msg: string, ctx?: LogContext): void;
};

/**
 * Default console-backed logger. Uses partial application (`log`) to bind
 * each log level to its corresponding `console` method while forwarding
 * the optional context object as a second argument.
 */
const log = (fn: (...args: unknown[]) => void) => (msg: string, ctx?: LogContext) =>
  fn(msg, ...(ctx ? [ctx] : []));

export const consoleLogger: Logger = {
  info: log(console.log),
  warn: log(console.warn),
  error: log(console.error),
  debug: log(console.debug),
};

/**
 * Speech-to-Speech (S2S) endpoint configuration.
 *
 * Controls which AssemblyAI real-time WebSocket endpoint to connect to and
 * the audio sample rates for input (microphone → STT) and output (TTS → speaker).
 */
export type S2SConfig = {
  /** The WebSocket URL of the S2S real-time endpoint. */
  wssUrl: string;
  /** Sample rate in Hz for audio sent to STT (microphone capture). */
  inputSampleRate: number;
  /** Sample rate in Hz for TTS audio received from the server. */
  outputSampleRate: number;
};

/** Default S2S endpoint configuration. */
export const DEFAULT_S2S_CONFIG: S2SConfig = {
  wssUrl: "wss://speech-to-speech.us.assemblyai.com/v1/realtime",
  inputSampleRate: DEFAULT_STT_SAMPLE_RATE,
  outputSampleRate: DEFAULT_TTS_SAMPLE_RATE,
};
