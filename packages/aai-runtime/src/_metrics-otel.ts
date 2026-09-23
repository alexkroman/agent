// Copyright 2026 the AAI authors. MIT license.
/**
 * The OTel half of METRIC export: a `MeterProvider` with an OTLP exporter,
 * wired to the metrics sink registry.
 *
 * Reached ONLY through `tracing.ts`'s dynamic `import()`, exactly as
 * `_tracing-otel.ts` is, and for the same two reasons: an unconfigured process
 * never evaluates the OTel graph, and the peers are OPTIONAL, so every import
 * of one here is `import type` or a dynamic `import()` (`check:optional-peers`
 * — `OtelPeers` in `_tracing-otel.ts` carries the build-time argument).
 *
 * ## Its peers are loaded SEPARATELY from the trace peers, and may be missing
 *
 * A self-hoster who installed the five trace peers before metrics existed has
 * a working tracing setup, and `OTEL_EXPORTER_OTLP_ENDPOINT` arms both halves.
 * Requiring the two metrics packages in the same load would turn that
 * deployment's next upgrade into an exception at boot — so a missing metrics
 * peer is answered with ONE line naming them, and tracing carries on.
 *
 * What this module records is only what the sink receives: the per-reply
 * `metrics.collected` measurements, which carry no transcript, no prompt and
 * no tool data by construction (`protocol-events-metrics.ts`). The content rule
 * `tracing.ts` states for spans holds here without an allow-list, because
 * there is no content in the input to leave out.
 *
 * @module
 */

import type { PushMetricExporter } from "@opentelemetry/sdk-metrics";
import pTimeout from "p-timeout";
import { otelMetricsSink, registerMetricsSink } from "./metrics-sink.ts";

/** The metric peers, as loaded namespaces — see the module doc. */
export type OtelMetricPeers = {
  api: typeof import("@opentelemetry/api");
  resources: typeof import("@opentelemetry/resources");
  sdk: typeof import("@opentelemetry/sdk-metrics");
  exporter: typeof import("@opentelemetry/exporter-metrics-otlp-proto");
};

/** Load the peers, or reject. In parallel, like `loadOtelPeers`. */
export async function loadOtelMetricPeers(): Promise<OtelMetricPeers> {
  const [api, resources, sdk, exporter] = await Promise.all([
    import("@opentelemetry/api"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/exporter-metrics-otlp-proto"),
  ]);
  return { api, resources, sdk, exporter };
}

/** A started meter — the same shape as `TracingHandle`'s drain half. */
export type MetricsHandle = {
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
};

/** As `DRAIN_TIMEOUT_MS` in `_tracing-otel.ts`, for the same torn-down guest. */
const DRAIN_TIMEOUT_MS = 2000;

/**
 * How often a reader pushes. The OTel default is 60s, which is right for a
 * long-lived server and loses a whole minute of replies from a guest the idle
 * reaper stops — `shutdown` flushes, but a sandbox terminate is not always
 * given the chance. `OTEL_METRIC_EXPORT_INTERVAL` still wins when set: the
 * reader reads it itself.
 */
const DEFAULT_EXPORT_INTERVAL_MS = 15_000;

export function startMetricsOtel(
  peers: OtelMetricPeers,
  serviceName: string,
  env: NodeJS.ProcessEnv,
  /** Test seam: the real exporter dials the collector named in `process.env`. */
  createExporter: () => PushMetricExporter = () => new peers.exporter.OTLPMetricExporter(),
): MetricsHandle {
  const { api, resources, sdk } = peers;
  const interval = Number(env.OTEL_METRIC_EXPORT_INTERVAL);
  const provider = new sdk.MeterProvider({
    resource: resources
      .defaultResource()
      .merge(resources.resourceFromAttributes({ "service.name": serviceName })),
    readers: [
      new sdk.PeriodicExportingMetricReader({
        exporter: createExporter(),
        exportIntervalMillis:
          Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_EXPORT_INTERVAL_MS,
      }),
    ],
  });
  // Global too, so OTel-aware code an agent brings (an instrumented driver,
  // a user's own meter) exports through the same pipeline.
  api.metrics.setGlobalMeterProvider(provider);
  const unregister = registerMetricsSink(otelMetricsSink(provider.getMeter("aai-runtime")));

  const guard = (run: () => Promise<void>) => async () => {
    try {
      await pTimeout(run(), { milliseconds: DRAIN_TIMEOUT_MS, message: "metrics drain timed out" });
    } catch {
      // A collector that is down may not fail a shutdown — see `_tracing-otel.ts`.
    }
  };
  let stopped = false;
  return {
    forceFlush: guard(() => provider.forceFlush()),
    shutdown: guard(async () => {
      if (stopped) return;
      stopped = true;
      unregister();
      await provider.shutdown();
    }),
  };
}
