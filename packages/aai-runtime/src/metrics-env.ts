// Copyright 2026 the AAI authors. MIT license.
/**
 * The environment gate for METRIC export — which variables name a metrics
 * collector, and the standard switch that turns it off.
 *
 * Split from `tracing.ts` so the metrics capability owns its own names:
 * `startTracing` still arms metric export off the same environment (one
 * `OTEL_EXPORTER_OTLP_ENDPOINT` arms both), and imports this to decide.
 *
 * @module
 */

/**
 * The standard variables that name a METRICS collector. Either one arms metric
 * export — the generic one arms traces and metrics together, which is what an
 * operator pointing everything at one collector expects.
 */
export const OTEL_METRICS_ENDPOINT_ENVS = [
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
] as const;

/** The standard switch: `none` turns metric export off whatever the endpoint. */
export const OTEL_METRICS_EXPORTER_ENV = "OTEL_METRICS_EXPORTER";

/**
 * The collector this environment names for METRICS, or `undefined`.
 *
 * `OTEL_METRICS_EXPORTER=none` closes it, which is the standard spelling for
 * "traces, but not metrics" when both share `OTEL_EXPORTER_OTLP_ENDPOINT`.
 */
export function metricsEndpoint(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env[OTEL_METRICS_EXPORTER_ENV]?.trim().toLowerCase() === "none") return undefined;
  for (const name of OTEL_METRICS_ENDPOINT_ENVS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}
