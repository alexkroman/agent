// Copyright 2025 the AAI authors. MIT license.

/**
 * Runtime dependencies injected into the session pipeline.
 *
 * Defines the {@link Logger} interface, a default {@link consoleLogger},
 * and the {@link S2SConfig} for Speech-to-Speech endpoint configuration.
 */

import { DEFAULT_STT_SAMPLE_RATE, DEFAULT_TTS_SAMPLE_RATE } from "../sdk/constants.ts";

/** Structured context attached to log messages. */
type LogContext = Record<string, unknown>;

type LogLevel = "info" | "warn" | "error" | "debug";

type LogFn = (msg: string, ctx?: LogContext) => void;

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
export type Logger = Record<LogLevel, LogFn>;

function consoleLog(fn: typeof console.log): LogFn {
  return (msg, ctx) => (ctx ? fn(msg, ctx) : fn(msg));
}

/** Parse a debug-flag env value (`AAI_DEBUG`): `"1"` / `"true"` enable it. */
export function isDebugEnv(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/**
 * Whether debug logging is enabled for this process (`AAI_DEBUG=1`).
 *
 * Read once at module load — it gates per-message hot paths (audio frames,
 * stream deltas), so callers must not pay a `process.env` lookup per call.
 * Hot-path call sites also use this flag to skip building expensive log
 * payloads (e.g. `JSON.stringify` of full wire messages) entirely.
 */
export const debugLoggingEnabled: boolean = isDebugEnv(process.env.AAI_DEBUG);

const noopLog: LogFn = () => undefined;

/**
 * Build a console-backed {@link Logger}. `debug` is a live `console.debug`
 * only when debug logging is enabled (see {@link debugLoggingEnabled});
 * otherwise it is a no-op so per-message hot-path logs cost nothing.
 */
export function createConsoleLogger(debug: boolean = debugLoggingEnabled): Logger {
  return {
    info: consoleLog(console.log),
    warn: consoleLog(console.warn),
    error: consoleLog(console.error),
    debug: debug ? consoleLog(console.debug) : noopLog,
  };
}

/** Default console-backed logger. Debug output requires `AAI_DEBUG=1`. */
export const consoleLogger: Logger = createConsoleLogger();

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
  wssUrl: "wss://agents.assemblyai.com/v1/ws",
  inputSampleRate: DEFAULT_STT_SAMPLE_RATE,
  outputSampleRate: DEFAULT_TTS_SAMPLE_RATE,
};
