// Copyright 2026 the AAI authors. MIT license.
/**
 * The two dynamic imports behind `tracing.ts`'s env gate, as one object.
 *
 * A seam rather than inline `import()`s so a spec can make a load FAIL — the
 * optional-peer path a self-hoster takes when a collector is configured and the
 * exporter was never installed — by `vi.spyOn` on a member, instead of
 * replacing the module. Nothing is imported until a member is CALLED, so the
 * unconfigured path still loads no OTel at all.
 */

/** Each half of the lazy OTel load, keyed by which export it serves. */
export const otelModules = {
  /** Span export — `startSpanExport` in `tracing.ts`. */
  tracing: () => import("./_tracing-otel.ts"),
  /** Metric export — `startMetricExport` in `tracing.ts`. */
  metrics: () => import("./_metrics-otel.ts"),
};
