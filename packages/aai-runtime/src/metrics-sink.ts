// Copyright 2026 the AAI authors. MIT license.
/**
 * Where a session's `metrics.collected` frames go BESIDES the session.
 *
 * A frame already reaches the client and the agent's own `events` hooks, which
 * is every reader that belongs to one SESSION. What that leaves out is the
 * reader that belongs to the PROCESS — a metrics backend that wants every
 * reply of every session as one histogram. A sink is that reader:
 *
 * ```ts
 * import { createMetricsCollector } from "@alexkroman1/aai";
 * import {
 *   type OtelMeterLike,
 *   otelMetricsSink,
 *   registerMetricsSink,
 * } from "@alexkroman1/aai-runtime/metrics";
 *
 * // A meter from your own MeterProvider — a Prometheus exporter, say:
 * // `metrics.getMeter("my-agent")` from `@opentelemetry/api`.
 * export function exportTo(meter: OtelMeterLike): void {
 *   registerMetricsSink(otelMetricsSink(meter));
 * }
 *
 * // Or keep a summary in-process, for a /stats route:
 * const summary = createMetricsCollector();
 * registerMetricsSink({ record: (e) => summary.collect(e) });
 * ```
 *
 * With a collector configured (`OTEL_EXPORTER_OTLP_ENDPOINT`), `startTracing`
 * registers an OTLP sink itself, so a self-hoster, `aai dev` and a deployed
 * guest export metrics with no code at all — see `tracing.ts`.
 *
 * ## The registry is keyed on `globalThis`
 *
 * A deployed guest holds TWO copies of this package: the harness's, which
 * starts the exporter at boot, and the agent bundle's, which runs the sessions
 * (`packages/aai-runtime/CLAUDE.md`, "A deployed guest has TWO copies of this
 * package"). A module-level list would put the sink in one copy and the frames
 * in the other, and the collector would receive nothing with nothing failing.
 * `Symbol.for` is the one key both copies resolve to.
 *
 * ## A sink cannot hurt a session
 *
 * Recording runs synchronously on the emit path, once per reply. A sink that
 * throws is caught and dropped for that frame: telemetry that takes down a
 * live call is worse than telemetry that misses one.
 *
 * @module
 */

import type { MetricsCollectedEvent } from "@alexkroman1/aai";

/**
 * Which session a frame came from. `agent` is the agent's `name`; a sink that
 * labels a metric with it should prefer it to `sessionId`, whose cardinality is
 * one series per call.
 * @public
 */
export interface MetricsContext {
  agent: string;
  sessionId: string;
}

/**
 * A process-wide reader of every session's `metrics.collected` frames.
 * @public
 */
export interface MetricsSink {
  record(event: MetricsCollectedEvent, context: MetricsContext): void;
}

const REGISTRY = Symbol.for("aai.runtime.metrics-sinks");

type Registry = { sinks: Set<MetricsSink> };

function registry(): Registry {
  const g = globalThis as { [REGISTRY]?: Registry };
  g[REGISTRY] ??= { sinks: new Set() };
  return g[REGISTRY];
}

/**
 * Add a sink for every session in this process. Answers the function that
 * removes it again.
 * @public
 */
export function registerMetricsSink(sink: MetricsSink): () => void {
  const { sinks } = registry();
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

/**
 * Hand one frame to every registered sink. Called by the session emitter.
 * @internal
 */
export function recordSessionMetrics(event: MetricsCollectedEvent, context: MetricsContext): void {
  for (const sink of registry().sinks) {
    try {
      sink.record(event, context);
    } catch {
      // See the module doc: a sink's failure is never the session's.
    }
  }
}

/**
 * The slice of an OpenTelemetry `Meter` {@link otelMetricsSink} uses, stated
 * structurally so this module imports no OpenTelemetry — `@opentelemetry/api`
 * is an optional peer, and a static import of it here would break every bundle
 * of a project that did not install it (`check:optional-peers`).
 * @public
 */
export interface OtelMeterLike {
  createHistogram(
    name: string,
    options?: { description?: string; unit?: string },
  ): { record(value: number, attributes?: Record<string, string | boolean>): void };
  createCounter(
    name: string,
    options?: { description?: string; unit?: string },
  ): { add(value: number, attributes?: Record<string, string | boolean>): void };
}

/**
 * The instrument names {@link otelMetricsSink} records, one per measurement in
 * a `metrics.collected` frame. Every duration is a histogram in milliseconds.
 * @public
 */
export const OTEL_METRIC_NAMES = {
  replies: "aai.replies",
  latency: "aai.reply.latency",
  sttEndpointing: "aai.stt.endpointing_delay",
  llmTtft: "aai.llm.time_to_first_token",
  llmDuration: "aai.llm.duration",
  llmTokens: "aai.llm.tokens",
  ttsTtfb: "aai.tts.time_to_first_byte",
  ttsCharacters: "aai.tts.characters",
} as const;

/**
 * A sink recording each frame onto OpenTelemetry instruments of `meter`.
 *
 * Every point carries `aai.agent`; `aai.replies` also carries
 * `aai.reply.interrupted`, and `aai.llm.tokens` carries `aai.token.type`
 * (`input` / `output`). The session id is deliberately NOT an attribute — it
 * would be a new time series per call.
 * @public
 */
export function otelMetricsSink(meter: OtelMeterLike): MetricsSink {
  const ms = (name: string, description: string) =>
    meter.createHistogram(name, { description, unit: "ms" });
  const replies = meter.createCounter(OTEL_METRIC_NAMES.replies, {
    description: "Replies settled, completed or interrupted",
  });
  const latency = ms(OTEL_METRIC_NAMES.latency, "Committed caller turn to first reply audio");
  const endpointing = ms(OTEL_METRIC_NAMES.sttEndpointing, "Last heard word to committed turn");
  const ttft = ms(OTEL_METRIC_NAMES.llmTtft, "Model request to its first content part");
  const llmDuration = ms(OTEL_METRIC_NAMES.llmDuration, "Model request to stream settled");
  const tokens = meter.createCounter(OTEL_METRIC_NAMES.llmTokens, {
    description: "Tokens the provider reported",
    unit: "{token}",
  });
  const ttfb = ms(OTEL_METRIC_NAMES.ttsTtfb, "First text into TTS to its first audio");
  const characters = meter.createCounter(OTEL_METRIC_NAMES.ttsCharacters, {
    description: "Characters sent to TTS",
    unit: "{character}",
  });

  const recordIf = (
    h: ReturnType<OtelMeterLike["createHistogram"]>,
    value: number | undefined,
    attrs: Record<string, string>,
  ): void => {
    if (value !== undefined) h.record(value, attrs);
  };

  return {
    record(event, { agent }) {
      const attrs = { "aai.agent": agent };
      replies.add(1, { ...attrs, "aai.reply.interrupted": event.interrupted });
      recordIf(latency, event.latencyMs, attrs);
      recordIf(endpointing, event.stt?.endpointingMs, attrs);
      if (event.llm) {
        recordIf(ttft, event.llm.ttftMs, attrs);
        llmDuration.record(event.llm.durationMs, attrs);
        if (event.llm.inputTokens)
          tokens.add(event.llm.inputTokens, { ...attrs, "aai.token.type": "input" });
        if (event.llm.outputTokens)
          tokens.add(event.llm.outputTokens, { ...attrs, "aai.token.type": "output" });
      }
      if (event.tts) {
        recordIf(ttfb, event.tts.ttfbMs, attrs);
        characters.add(event.tts.characters, attrs);
      }
    },
  };
}
