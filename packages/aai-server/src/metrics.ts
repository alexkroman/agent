// Copyright 2025 the AAI authors. MIT license.
/**
 * Lightweight Prometheus metrics using only workerd primitives.
 *
 * Platform view:  GET /metrics          -> serialize()
 * Customer view:  GET /:slug/metrics    -> serializeForAgent("slug")
 */

type Labels = Record<string, string>;

type MetricValue = {
  value: number;
  labels: Record<string, string | number | undefined>;
  metricName?: string;
};

type MetricJSON = {
  name: string;
  help: string;
  type: string;
  values: MetricValue[];
};

// In-memory registry

const metrics: MetricJSON[] = [];

function findOrCreate(name: string, help: string, type: string): MetricJSON {
  let m = metrics.find((x) => x.name === name);
  if (!m) {
    m = { name, help, type, values: [] };
    metrics.push(m);
  }
  return m;
}

function labelsKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

function findValue(m: MetricJSON, labels: Labels, metricName?: string): MetricValue {
  const key = labelsKey(labels);
  let v = m.values.find(
    (x) =>
      labelsKey(x.labels as Labels) === key &&
      (metricName ? x.metricName === metricName : !x.metricName),
  );
  if (!v) {
    v = { value: 0, labels: { ...labels }, metricName };
    m.values.push(v);
  }
  return v;
}

// Formatting

function leString(val: unknown): string {
  if (val === Infinity || val === "Infinity") return "+Inf";
  return String(val);
}

function formatLabels(labels: Record<string, unknown>, skip?: string): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(labels)) {
    if (k === skip) continue;
    parts.push(`${k}="${k === "le" ? leString(v) : String(v)}"`);
  }
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
}

function formatMetric(metric: MetricJSON): string {
  const lines = [`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} ${metric.type}`];
  for (const v of metric.values) {
    const suffix = formatLabels(v.labels);
    lines.push(`${v.metricName ?? metric.name}${suffix} ${v.value}`);
  }
  return lines.join("\n");
}

function formatForAgent(metric: MetricJSON, agent: string): string {
  const lines = [`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} ${metric.type}`];
  if (!metric.values.some((v) => "agent" in v.labels)) {
    return lines.join("\n");
  }
  for (const v of metric.values) {
    if (v.labels.agent !== agent) continue;
    const suffix = formatLabels(v.labels, "agent");
    lines.push(`${v.metricName ?? metric.name}${suffix} ${v.value}`);
  }
  return lines.join("\n");
}

// Public API

export async function serialize(): Promise<string> {
  return `${metrics.map((m) => formatMetric(m)).join("\n\n")}\n`;
}

export async function serializeForAgent(agent: string): Promise<string> {
  return `${metrics.map((m) => formatForAgent(m, agent)).join("\n\n")}\n`;
}

type CounterLike = {
  inc(labels?: Labels, n?: number): void;
  serialize(agent?: string): Promise<string>;
};

type GaugeLike = {
  inc(labels?: Labels): void;
  dec(labels?: Labels): void;
  serialize(agent?: string): Promise<string>;
};

type HistogramLike = {
  observe(value: number, labels?: Labels): void;
  serialize(agent?: string): Promise<string>;
};

const DEFAULT_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

function createCounter(name: string, opts: { help: string; labelNames?: string[] }): CounterLike {
  const m = findOrCreate(name, opts.help, "counter");
  return {
    inc(labels?: Labels, n = 1) {
      findValue(m, labels ?? {}).value += n;
    },
    serialize: (agent?: string) =>
      Promise.resolve(agent ? formatForAgent(m, agent) : formatMetric(m)),
  };
}

function createGauge(name: string, opts: { help: string; labelNames?: string[] }): GaugeLike {
  const m = findOrCreate(name, opts.help, "gauge");
  return {
    inc(labels?: Labels) {
      findValue(m, labels ?? {}).value += 1;
    },
    dec(labels?: Labels) {
      findValue(m, labels ?? {}).value -= 1;
    },
    serialize: (agent?: string) =>
      Promise.resolve(agent ? formatForAgent(m, agent) : formatMetric(m)),
  };
}

function createHistogram(
  name: string,
  opts: { help: string; buckets?: number[]; labelNames?: string[] },
): HistogramLike {
  const m = findOrCreate(name, opts.help, "histogram");
  const buckets = opts.buckets ?? DEFAULT_BUCKETS;

  return {
    observe(value: number, labels?: Labels) {
      const base = labels ?? {};
      findValue(m, base, `${name}_sum`).value += value;
      findValue(m, base, `${name}_count`).value += 1;
      for (const le of buckets) {
        if (value <= le) {
          findValue(m, { ...base, le: le as unknown as string }, `${name}_bucket`).value += 1;
        }
      }
      findValue(m, { ...base, le: "+Inf" }, `${name}_bucket`).value += 1;
    },
    serialize: (agent?: string) =>
      Promise.resolve(agent ? formatForAgent(m, agent) : formatMetric(m)),
  };
}

export const _internals = { createCounter, createGauge, createHistogram };
