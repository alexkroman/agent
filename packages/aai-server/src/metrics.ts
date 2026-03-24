// Copyright 2025 the AAI authors. MIT license.
/**
 * Prometheus metrics backed by prom-client.
 *
 * Platform view:  GET /metrics          -> serialize()
 * Customer view:  GET /:slug/metrics    -> serializeForAgent("slug")
 */

import client from "prom-client";

const registry = new client.Registry();

export async function serialize(): Promise<string> {
  return registry.metrics();
}

export async function serializeForAgent(agent: string): Promise<string> {
  const dump = await registry.getMetricsAsJSON();
  const lines: string[] = [];

  for (const metric of dump) {
    lines.push(`# HELP ${metric.name} ${metric.help}`);
    lines.push(`# TYPE ${metric.name} ${metric.type}`);

    for (const v of metric.values) {
      if (!v.labels || (v.labels as Record<string, string>).agent !== agent) continue;
      const filtered = { ...v.labels } as Record<string, string>;
      delete filtered.agent;
      const labelStr = Object.entries(filtered)
        .map(([k, val]) => `${k}="${val}"`)
        .join(",");
      const suffix = labelStr ? `{${labelStr}}` : "";
      const name = (v as { metricName?: string }).metricName ?? metric.name;
      lines.push(`${name}${suffix} ${v.value}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function createCounter(name: string, opts: { help: string; labelNames?: string[] }) {
  return new client.Counter({
    name,
    help: opts.help,
    labelNames: opts.labelNames ?? [],
    registers: [registry],
  });
}

function createGauge(name: string, opts: { help: string; labelNames?: string[] }) {
  return new client.Gauge({
    name,
    help: opts.help,
    labelNames: opts.labelNames ?? [],
    registers: [registry],
  });
}

function createHistogram(
  name: string,
  opts: { help: string; buckets?: number[]; labelNames?: string[] },
) {
  return new client.Histogram({
    name,
    help: opts.help,
    buckets: opts.buckets ?? [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    labelNames: opts.labelNames ?? [],
    registers: [registry],
  });
}

export const _internals = { createCounter, createGauge, createHistogram, registry };
