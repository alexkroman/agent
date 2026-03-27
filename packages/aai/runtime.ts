// Copyright 2025 the AAI authors. MIT license.

/**
 * Runtime dependencies injected into the session pipeline.
 *
 * Defines the {@link Logger} interface, a default {@link consoleLogger},
 * and the {@link S2SConfig} for Speech-to-Speech endpoint configuration.
 */

import { context, trace } from "@opentelemetry/api";
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

/** Default console-backed logger. */
export const consoleLogger: Logger = {
  info: (msg, ctx?) => (ctx ? console.log(msg, ctx) : console.log(msg)),
  warn: (msg, ctx?) => (ctx ? console.warn(msg, ctx) : console.warn(msg)),
  error: (msg, ctx?) => (ctx ? console.error(msg, ctx) : console.error(msg)),
  debug: (msg, ctx?) => (ctx ? console.debug(msg, ctx) : console.debug(msg)),
};

/**
 * Structured JSON logger for production diagnostics. Each log entry is a
 * single-line JSON object with `timestamp`, `level`, `msg`, and any
 * caller-provided context fields. When an active OpenTelemetry span exists,
 * `trace_id` and `span_id` are included automatically.
 */
function jsonLog(level: string) {
  return (msg: string, ctx?: LogContext): void => {
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      msg,
    };

    // Attach OTel trace context when available.
    const span = trace.getSpan(context.active());
    if (span) {
      const sc = span.spanContext();
      entry.trace_id = sc.traceId;
      entry.span_id = sc.spanId;
    }

    if (ctx) {
      Object.assign(entry, ctx);
    }

    // Single-line JSON to stdout/stderr based on level.
    const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
    out.write(`${JSON.stringify(entry)}\n`);
  };
}

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
  wssUrl: "wss://speech-to-speech.us.assemblyai.com/v1/realtime",
  inputSampleRate: DEFAULT_STT_SAMPLE_RATE,
  outputSampleRate: DEFAULT_TTS_SAMPLE_RATE,
};
