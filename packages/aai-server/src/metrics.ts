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

type NumberDataPoint = DataPoint<number>;

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

/** Detect histogram by checking if data point value has bucket structure. */
function isHistogramDataPoint(dp: NumberDataPoint): boolean {
  const val = dp.value as unknown;
  return typeof val === "object" && val !== null && "buckets" in val;
}

function filterLabels(
  dp: NumberDataPoint,
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
  dp: NumberDataPoint,
  labelStr: string,
): void {
  const val = dp.value as unknown as HistogramValue;
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
  dataPoints: NumberDataPoint[],
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

function detectMetricType(dataPoints: NumberDataPoint[]): string {
  const first = dataPoints[0];
  if (first !== undefined && isHistogramDataPoint(first)) return "histogram";
  return "gauge";
}

function formatResult(result: CollectionResult, agentFilter: string | undefined): string {
  const lines: string[] = [];
  for (const scopeMetrics of result.resourceMetrics.scopeMetrics) {
    for (const metric of scopeMetrics.metrics) {
      const { descriptor, dataPoints } = metric;
      const dps = dataPoints as NumberDataPoint[];
      const promType = detectMetricType(dps);
      lines.push(`# HELP ${descriptor.name} ${descriptor.description ?? ""}`);
      lines.push(`# TYPE ${descriptor.name} ${promType}`);
      formatDataPoints(lines, descriptor.name, dps, agentFilter);
    }
  }
  return `${lines.join("\n")}\n`;
}

// ─── Convenience factories (for server-specific metrics) ─────────────────────

const serverMeter = metrics.getMeter("aai-server", "0.8.9");

function createCounter(name: string, opts: { help: string; labelNames?: string[] }) {
  return serverMeter.createCounter(name, { description: opts.help });
}

function createGauge(name: string, opts: { help: string; labelNames?: string[] }) {
  return serverMeter.createUpDownCounter(name, { description: opts.help });
}

function createHistogram(
  name: string,
  opts: { help: string; buckets?: number[]; labelNames?: string[] },
) {
  const options: { description: string; advice?: { explicitBucketBoundaries: number[] } } = {
    description: opts.help,
  };
  if (opts.buckets) {
    options.advice = { explicitBucketBoundaries: opts.buckets };
  }
  return serverMeter.createHistogram(name, options);
}

/** @internal Not part of the public API. Exposed for testing only. */
export const _internals = {
  createCounter,
  createGauge,
  createHistogram,
  meterProvider,
  exporter,
};
