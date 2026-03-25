// Copyright 2025 the AAI authors. MIT license.
/**
 * OpenTelemetry instrumentation helpers for the AAI SDK.
 *
 * Uses `@opentelemetry/api` only — consumers bring their own SDK and
 * exporters.  When no SDK is configured the API returns no-op instances,
 * so the overhead in uninstrumented environments is negligible.
 *
 * Provides:
 * - `tracer`  — a pre-scoped `Tracer` for creating spans
 * - `meter`   — a pre-scoped `Meter` for recording metrics
 * - Pre-built counters, histograms, and up/down counters covering the
 *   STT → LLM → TTS pipeline
 */

import {
  type Meter,
  metrics,
  type Span,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";

// ─── Scoped instances ────────────────────────────────────────────────────────

const SCOPE = "aai";
const VERSION = "0.9.3";

/** Tracer scoped to the AAI SDK. */
export const tracer: Tracer = trace.getTracer(SCOPE, VERSION);

/** Meter scoped to the AAI SDK. */
export const meter: Meter = metrics.getMeter(SCOPE, VERSION);

// ─── Pre-built metrics ──────────────────────────────────────────────────────

/** Total sessions opened. */
export const sessionCounter = meter.createCounter("aai.session.count", {
  description: "Total voice sessions opened",
});

/** Currently active sessions. */
export const activeSessionsUpDown = meter.createUpDownCounter("aai.session.active", {
  description: "Currently active voice sessions",
});

/** Total user turns (speech → transcript). */
export const turnCounter = meter.createCounter("aai.turn.count", {
  description: "Total user turns",
});

/** Total tool calls executed. */
export const toolCallCounter = meter.createCounter("aai.tool.call.count", {
  description: "Total tool calls executed",
});

/** Tool call execution duration in seconds. */
export const toolCallDuration = meter.createHistogram("aai.tool.call.duration", {
  description: "Tool call execution duration in seconds",
  unit: "s",
});

/** Total tool call errors. */
export const toolCallErrorCounter = meter.createCounter("aai.tool.call.error.count", {
  description: "Total tool call errors",
});

/** S2S WebSocket connection duration in seconds. */
export const s2sConnectionDuration = meter.createHistogram("aai.s2s.connection.duration", {
  description: "S2S WebSocket connection duration in seconds",
  unit: "s",
});

/** Total S2S errors. */
export const s2sErrorCounter = meter.createCounter("aai.s2s.error.count", {
  description: "Total S2S errors",
});

/** Total barge-in (reply interrupted) events. */
export const bargeInCounter = meter.createCounter("aai.turn.bargein.count", {
  description: "Total barge-in (reply interrupted) events",
});

// ─── Span helpers ────────────────────────────────────────────────────────────

/**
 * Run `fn` inside a new span. The span is automatically ended and its
 * status set based on whether `fn` throws.
 */
export function withSpan<T>(name: string, fn: (span: Span) => T): T {
  return tracer.startActiveSpan(name, (span) => {
    try {
      const result = fn(span);
      // Handle promises
      if (result instanceof Promise) {
        return result
          .then((v) => {
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            return v;
          })
          .catch((err: unknown) => {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: err instanceof Error ? err.message : String(err),
            });
            span.recordException(err instanceof Error ? err : new Error(String(err)));
            span.end();
            throw err;
          }) as T;
      }
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    } catch (err: unknown) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.end();
      throw err;
    }
  });
}

export type { Meter, Span, Tracer } from "@opentelemetry/api";
export { context, metrics, SpanStatusCode, trace } from "@opentelemetry/api";
