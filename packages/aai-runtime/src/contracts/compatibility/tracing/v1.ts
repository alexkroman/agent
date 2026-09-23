// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring template: `aai-runtime:tracing` epoch 1.
 *
 * What a self-hoster who embeds the runtime does with span export: read the
 * gate, start it, and hold the handle to flush on shutdown — written the way
 * it was at epoch 1. It must keep compiling for as long as epoch 1 is
 * advertised as supported.
 *
 * ## What moved, and why epoch 1 survives it
 *
 * Epoch 2 ADDED metric export on the same gate and subpath — the metrics
 * variables, `metricsEndpoint`, and the process-wide sink registry
 * (`registerMetricsSink`, `otelMetricsSink`). Nothing epoch 1 exported
 * changed: `startTracing` still answers `RuntimeTracing | undefined` and
 * the handle still has exactly `forceFlush` and `shutdown`, which now drain
 * the meter as well as the tracer. So the bootstrap below is unchanged.
 *
 * It names all seven of epoch 1's exports.
 *
 * Relative specifiers, as every frozen example.
 *
 * @module
 */

import {
  DEFAULT_SERVICE_NAME,
  OTEL_ENDPOINT_ENVS,
  OTEL_SERVICE_NAME_ENV,
  type RuntimeTracing,
  startTracing,
  startTracingDetached,
  tracingEndpoint,
} from "../../../tracing.ts";

/** What a boot line prints about the collector. */
export function describeCollector(env: NodeJS.ProcessEnv): string {
  const endpoint = tracingEndpoint(env);
  if (endpoint === undefined) return `tracing off (set one of ${OTEL_ENDPOINT_ENVS.join(", ")})`;
  const service = env[OTEL_SERVICE_NAME_ENV] ?? DEFAULT_SERVICE_NAME;
  return `tracing ${service} → ${endpoint}`;
}

/** A host that awaits the start, and drains on the way out. */
export async function bootWithTracing(onShutdown: (drain: () => Promise<void>) => void) {
  const tracing: RuntimeTracing | undefined = await startTracing();
  if (tracing) onShutdown(() => tracing.shutdown());
  return tracing;
}

/** A host that must not wait — the harness's shape. */
export function bootDetached(): void {
  startTracingDetached();
}
