// Copyright 2025 the AAI authors. MIT license.
/**
 * Pluggable interfaces for cross-runtime concerns.
 *
 * @module
 */

import { DEFAULT_TTS_SAMPLE_RATE } from "./protocol.ts";

/** Structured context attached to log messages. */
export type LogContext = Record<string, unknown>;

/** Runtime-agnostic structured logger. */
export type Logger = {
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  debug(msg: string, ctx?: LogContext): void;
};

/** Runtime-agnostic session metrics. */
export type Metrics = {
  sessionsTotal: { inc(labels: Record<string, string>): void };
  sessionsActive: {
    inc(labels: Record<string, string>): void;
    dec(labels: Record<string, string>): void;
  };
};

/** Console-based logger that works in all runtimes. */
export const consoleLogger: Logger = {
  info(msg, ctx) {
    if (ctx) console.log(msg, ctx);
    else console.log(msg);
  },
  warn(msg, ctx) {
    if (ctx) console.warn(msg, ctx);
    else console.warn(msg);
  },
  error(msg, ctx) {
    if (ctx) console.error(msg, ctx);
    else console.error(msg);
  },
  debug(msg, ctx) {
    if (ctx) console.debug(msg, ctx);
    else console.debug(msg);
  },
};

/** No-op metrics implementation for environments without monitoring. */
export const noopMetrics: Metrics = {
  sessionsTotal: { inc() {} },
  sessionsActive: { inc() {}, dec() {} },
};

/** Configuration for the AssemblyAI Speech-to-Speech connection. */
export type S2SConfig = {
  wssUrl: string;
  inputSampleRate: number;
  outputSampleRate: number;
};

/** Default S2S configuration pointing to AssemblyAI's production endpoint. */
export const DEFAULT_S2S_CONFIG: S2SConfig = {
  wssUrl: "wss://speech-to-speech.us.assemblyai.com/v1/realtime",
  inputSampleRate: DEFAULT_TTS_SAMPLE_RATE,
  outputSampleRate: DEFAULT_TTS_SAMPLE_RATE,
};
