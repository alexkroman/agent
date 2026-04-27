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

// ── Session ──

const DEFAULT_DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 1800];

const sessionsStarted = new client.Counter({
  name: "aai_sessions_started_total",
  help: "Voice sessions started, labeled by slug and session mode.",
  labelNames: ["slug", "mode"] as const,
  registers: [registry],
});

const sessionsActive = new client.Gauge({
  name: "aai_sessions_active",
  help: "Currently-open WebSocket voice sessions, labeled by slug.",
  labelNames: ["slug"] as const,
  registers: [registry],
});

const sessionsEnded = new client.Counter({
  name: "aai_sessions_ended_total",
  help: "Voice sessions ended, labeled by slug and end reason.",
  labelNames: ["slug", "reason"] as const,
  registers: [registry],
});

const sessionDuration = new client.Histogram({
  name: "aai_session_duration_seconds",
  help: "Voice session duration, platform-wide (no slug to bound cardinality).",
  buckets: DEFAULT_DURATION_BUCKETS,
  registers: [registry],
});

const sessionErrors = new client.Counter({
  name: "aai_session_errors_total",
  help: "Session-path errors by kind.",
  labelNames: ["kind"] as const,
  registers: [registry],
});

// ── Sandbox ──

const SANDBOX_INIT_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8];

const sandboxInit = new client.Histogram({
  name: "aai_sandbox_init_seconds",
  help: "Time to bring an agent sandbox to ready state.",
  buckets: SANDBOX_INIT_BUCKETS,
  registers: [registry],
});

const sandboxInitFailed = new client.Counter({
  name: "aai_sandbox_init_failed_total",
  help: "Sandbox init failures, labeled by failure stage.",
  labelNames: ["reason"] as const,
  registers: [registry],
});

const sandboxEvicted = new client.Counter({
  name: "aai_sandbox_evicted_total",
  help: "Sandboxes evicted, labeled by reason.",
  labelNames: ["reason"] as const,
  registers: [registry],
});

const slotsRegistered = new client.Gauge({
  name: "aai_slots_registered",
  help: "Number of agent slots registered in the slot cache.",
  registers: [registry],
});

const slotsResident = new client.Gauge({
  name: "aai_slots_resident",
  help: "Number of slots with a live sandbox attached.",
  registers: [registry],
});

export const metrics = {
  sessionsStarted,
  sessionsActive,
  sessionsEnded,
  sessionDuration,
  sessionErrors,
  sandboxInit,
  sandboxInitFailed,
  sandboxEvicted,
  slotsRegistered,
  slotsResident,
};
