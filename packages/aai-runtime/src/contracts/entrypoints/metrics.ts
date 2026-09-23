// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `metrics`.
 *
 * Where a session's `metrics.collected` frames go besides the session: the
 * process-wide SINK registry (`registerMetricsSink`) that both the env-armed
 * OTLP exporter and a host's own reader attach to, the shipped OTel sink and
 * the structural meter it records onto, the metric names it records, and the
 * env gate that arms metric export.
 *
 * Split from `tracing`: a sink is a reader of session frames and moves with the
 * metrics vocabulary, while span export moves with the tracer. `startTracing`
 * still arms both off one environment.
 *
 * Re-exported from `@alexkroman1/aai-runtime/metrics`. This file is not shipped
 * and nothing imports it — it exists so `pnpm check:api-contracts` can extract
 * a report for this capability alone, hash it, and hold it to a committed
 * epoch. See `scripts/api-contracts.mjs`.
 */

export {
  type MetricsContext,
  type MetricsSink,
  metricsEndpoint,
  OTEL_METRIC_NAMES,
  OTEL_METRICS_ENDPOINT_ENVS,
  OTEL_METRICS_EXPORTER_ENV,
  type OtelMeterLike,
  otelMetricsSink,
  registerMetricsSink,
} from "../../metrics-barrel.ts";
