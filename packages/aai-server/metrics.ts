// Copyright 2025 the AAI authors. MIT license.
/**
 * Prometheus metrics for aai-server, backed by prom-client.
 *
 * Single registry. Every metric is constructed at module load — no
 * dynamic per-request creation. The `/metrics` endpoint serializes
 * `registry.metrics()`.
 *
 * Metrics naming: `aai_*` for our app, units in name (`_seconds`,
 * `_bytes`), `_total` suffix on counters. `slug` label only on the
 * permitlist enforced by `metrics-cardinality.test.ts`.
 */
import client from "prom-client";

export const registry = new client.Registry();

client.collectDefaultMetrics({ register: registry });

export async function serialize(): Promise<string> {
  return registry.metrics();
}
