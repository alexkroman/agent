// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai-runtime/metrics` — where a session's `metrics.collected`
 * frames go besides the session.
 *
 * {@link registerMetricsSink} attaches a process-wide reader; {@link otelMetricsSink}
 * is the shipped one, recording `aai.*` histograms and counters onto any
 * OpenTelemetry `Meter` (an {@link OtelMeterLike} is structural, so this package
 * imports no OTel to take one). With a collector configured, `startTracing` on
 * `@alexkroman1/aai-runtime/tracing` registers an OTLP sink itself; the env
 * variables and the gate it reads are here.
 *
 * ```ts
 * import {
 *   type OtelMeterLike,
 *   otelMetricsSink,
 *   registerMetricsSink,
 * } from "@alexkroman1/aai-runtime/metrics";
 *
 * export function exportTo(meter: OtelMeterLike): void {
 *   registerMetricsSink(otelMetricsSink(meter));
 * }
 * ```
 *
 * Its own subpath and capability rather than names on `/tracing`: a sink is a
 * reader of session frames, which moves with the metrics vocabulary, while span
 * export moves with the tracer.
 *
 * @module metrics
 */

export {
  metricsEndpoint,
  OTEL_METRICS_ENDPOINT_ENVS,
  OTEL_METRICS_EXPORTER_ENV,
} from "./metrics-env.ts";
export {
  type MetricsContext,
  type MetricsSink,
  OTEL_METRIC_NAMES,
  type OtelMeterLike,
  otelMetricsSink,
  registerMetricsSink,
} from "./metrics-sink.ts";
