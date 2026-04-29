// Copyright 2025 the AAI authors. MIT license.

/**
 * Runtime dependencies injected into the session pipeline.
 *
 * Defines the {@link Logger} interface, a default {@link consoleLogger},
 * and the {@link S2SConfig} for Speech-to-Speech endpoint configuration.
 */

import { DEFAULT_STT_SAMPLE_RATE, DEFAULT_TTS_SAMPLE_RATE } from "../sdk/constants.ts";

/** Structured context attached to log messages. */
export type LogContext = Record<string, unknown>;

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

/** Default console-backed logger. */
export const consoleLogger: Logger = {
  info: consoleLog(console.log),
  warn: consoleLog(console.warn),
  error: consoleLog(console.error),
  debug: consoleLog(console.debug),
};

function jsonLog(level: LogLevel): LogFn {
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  return (msg, ctx) => {
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      msg,
      ...ctx,
    };
    out.write(`${JSON.stringify(entry)}\n`);
  };
}

/**
 * Structured JSON logger for production diagnostics. Each log entry is a
 * single-line JSON object with `timestamp`, `level`, `msg`, and any
 * caller-provided context fields.
 */
export const jsonLogger: Logger = {
  info: jsonLog("info"),
  warn: jsonLog("warn"),
  error: jsonLog("error"),
  debug: jsonLog("debug"),
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
  wssUrl: "wss://agents.assemblyai.com/v1/ws",
  inputSampleRate: DEFAULT_STT_SAMPLE_RATE,
  outputSampleRate: DEFAULT_TTS_SAMPLE_RATE,
};
