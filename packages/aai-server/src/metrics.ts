// Copyright 2025 the AAI authors. MIT license.
/**
 * OpenTelemetry metrics backed by the OTel SDK.
 *
 * Replaces the former prom-client implementation with a unified
 * OpenTelemetry setup that provides metrics, traces, and logs from
 * a single SDK.
 *
 * Platform view:  GET /metrics          -> serialize()
 * Customer view:  GET /:slug/metrics    -> serializeForAgent("slug")
 */

import { metrics } from "@opentelemetry/api";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { type CollectionResult, type DataPoint, MeterProvider } from "@opentelemetry/sdk-metrics";

// ─── SDK Setup ───────────────────────────────────────────────────────────────

const exporter = new PrometheusExporter({ preventServerStart: true });

const meterProvider = new MeterProvider({
  readers: [exporter],
});

// Register as the global meter provider so SDK-level meters (e.g. in
// packages/aai/telemetry.ts) automatically flow through this provider.
metrics.setGlobalMeterProvider(meterProvider);

// ─── Prometheus serialization ────────────────────────────────────────────────

export async function serialize(): Promise<string> {
  const result = await collectMetrics();
  return formatResult(result, undefined);
}

export async function serializeForAgent(agent: string): Promise<string> {
  const result = await collectMetrics();
  return formatResult(result, agent);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

async function collectMetrics(): Promise<CollectionResult> {
  // PrometheusExporter extends MetricReader, so collect() is inherited directly.
  return exporter.collect();
}

/** Structural type matching OTel HistogramDataPoint.value */
type HistogramValue = {
  buckets: { boundaries: number[]; counts: number[] };
  count: number;
  sum: number;
};

function formatLabels(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(",");
}

/** Type-narrow a data point to one whose value is a histogram structure. */
function isHistogramDataPoint(
  dp: DataPoint<number | HistogramValue>,
): dp is DataPoint<HistogramValue> {
  const val: unknown = dp.value;
  return typeof val === "object" && val !== null && "buckets" in val;
}

function filterLabels(
  dp: DataPoint<number | HistogramValue>,
  agentFilter: string | undefined,
): { include: boolean; labelStr: string } {
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(dp.attributes)) {
    if (v != null) labels[k] = String(v);
  }
  if (agentFilter !== undefined) {
    if (labels.agent !== agentFilter) return { include: false, labelStr: "" };
    const { agent: _, ...rest } = labels;
    return { include: true, labelStr: formatLabels(rest) };
  }
  return { include: true, labelStr: formatLabels(labels) };
}

function pushHistogramLines(
  lines: string[],
  name: string,
  dp: DataPoint<HistogramValue>,
  labelStr: string,
): void {
  const val = dp.value;
  const { boundaries, counts } = val.buckets;
  for (let i = 0; i < boundaries.length; i++) {
    lines.push(
      `${name}_bucket{${labelStr ? `${labelStr},` : ""}le="${boundaries[i]}"} ${counts[i]}`,
    );
  }
  const suffix = labelStr ? `{${labelStr}}` : "";
  lines.push(`${name}_bucket{${labelStr ? `${labelStr},` : ""}le="+Inf"} ${val.count}`);
  lines.push(`${name}_sum${suffix} ${val.sum}`);
  lines.push(`${name}_count${suffix} ${val.count}`);
}

function formatDataPoints(
  lines: string[],
  name: string,
  dataPoints: DataPoint<number | HistogramValue>[],
  agentFilter: string | undefined,
): void {
  for (const dp of dataPoints) {
    const { include, labelStr } = filterLabels(dp, agentFilter);
    if (!include) continue;
    if (isHistogramDataPoint(dp)) {
      pushHistogramLines(lines, name, dp, labelStr);
    } else {
      const suffix = labelStr ? `{${labelStr}}` : "";
      lines.push(`${name}${suffix} ${dp.value}`);
    }
  }
}

function detectMetricType(dataPoints: DataPoint<number | HistogramValue>[]): string {
  const first = dataPoints[0];
  if (first !== undefined && isHistogramDataPoint(first)) return "histogram";
  return "gauge";
}

function formatResult(result: CollectionResult, agentFilter: string | undefined): string {
  const lines: string[] = [];
  for (const scopeMetrics of result.resourceMetrics.scopeMetrics) {
    for (const metric of scopeMetrics.metrics) {
      const { descriptor, dataPoints } = metric;
      const dps = dataPoints as DataPoint<number | HistogramValue>[];
      const promType = detectMetricType(dps);
      lines.push(`# HELP ${descriptor.name} ${descriptor.description ?? ""}`);
      lines.push(`# TYPE ${descriptor.name} ${promType}`);
      formatDataPoints(lines, descriptor.name, dps, agentFilter);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** @internal Not part of the public API. Exposed for testing only. */
export const _internals = {
  meterProvider,
  exporter,
};
