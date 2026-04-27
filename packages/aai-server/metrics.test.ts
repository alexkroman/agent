// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, it } from "vitest";
import { metrics, registry, serialize } from "./metrics.ts";

describe("metrics registry", () => {
  it("exposes default Node.js process metrics", async () => {
    const text = await serialize();
    expect(text).toContain("nodejs_eventloop_lag_p99_seconds");
    expect(text).toContain("process_resident_memory_bytes");
  });

  it("uses 'aai_' prefix as the canonical namespace for custom metrics", () => {
    expect(registry).toBeDefined();
  });
});

describe("session metrics", () => {
  it("counts sessions started by slug and mode", async () => {
    metrics.sessionsStarted.inc({ slug: "alpha", mode: "s2s" });
    metrics.sessionsStarted.inc({ slug: "alpha", mode: "s2s" });
    const text = await serialize();
    expect(text).toMatch(/aai_sessions_started_total\{[^}]*slug="alpha"[^}]*mode="s2s"\} 2/);
  });

  it("tracks active sessions as a gauge", async () => {
    metrics.sessionsActive.inc({ slug: "alpha" });
    metrics.sessionsActive.inc({ slug: "alpha" });
    metrics.sessionsActive.dec({ slug: "alpha" });
    const text = await serialize();
    expect(text).toMatch(/aai_sessions_active\{slug="alpha"\} 1/);
  });

  it("counts session ends by reason", async () => {
    metrics.sessionsEnded.inc({ slug: "alpha", reason: "client_close" });
    const text = await serialize();
    expect(text).toMatch(/aai_sessions_ended_total\{[^}]*reason="client_close"[^}]*\} 1/);
  });

  it("observes session durations", async () => {
    metrics.sessionDuration.observe(42);
    const text = await serialize();
    expect(text).toContain("aai_session_duration_seconds_bucket");
    expect(text).toContain("aai_session_duration_seconds_count 1");
  });

  it("counts session errors by kind", async () => {
    metrics.sessionErrors.inc({ kind: "internal" });
    const text = await serialize();
    expect(text).toMatch(/aai_session_errors_total\{kind="internal"\} 1/);
  });
});

describe("sandbox metrics", () => {
  it("observes init durations", async () => {
    metrics.sandboxInit.observe(0.42);
    const text = await serialize();
    expect(text).toContain("aai_sandbox_init_seconds_bucket");
    expect(text).toContain("aai_sandbox_init_seconds_count 1");
  });

  it("counts init failures by reason", async () => {
    metrics.sandboxInitFailed.inc({ reason: "bundle_missing" });
    const text = await serialize();
    expect(text).toMatch(/aai_sandbox_init_failed_total\{reason="bundle_missing"\} 1/);
  });

  it("counts evictions by reason", async () => {
    metrics.sandboxEvicted.inc({ reason: "idle" });
    const text = await serialize();
    expect(text).toMatch(/aai_sandbox_evicted_total\{reason="idle"\} 1/);
  });

  it("tracks slot population as gauges", async () => {
    metrics.slotsRegistered.set(7);
    metrics.slotsResident.set(3);
    const text = await serialize();
    expect(text).toMatch(/aai_slots_registered 7/);
    expect(text).toMatch(/aai_slots_resident 3/);
  });
});

describe("warm pool metrics", () => {
  it("publishes target/ready/pending gauges", async () => {
    metrics.warmPoolTarget.set(2);
    metrics.warmPoolReady.set(1);
    metrics.warmPoolPending.set(1);
    const text = await serialize();
    expect(text).toMatch(/aai_warm_pool_target 2/);
    expect(text).toMatch(/aai_warm_pool_ready 1/);
    expect(text).toMatch(/aai_warm_pool_pending 1/);
  });

  it("counts acquire hits and misses", async () => {
    metrics.warmPoolAcquire.inc({ result: "hit" });
    metrics.warmPoolAcquire.inc({ result: "miss" });
    metrics.warmPoolAcquire.inc({ result: "miss" });
    const text = await serialize();
    expect(text).toMatch(/aai_warm_pool_acquire_total\{result="hit"\} 1/);
    expect(text).toMatch(/aai_warm_pool_acquire_total\{result="miss"\} 2/);
  });

  it("counts spawn failures", async () => {
    metrics.warmPoolSpawnFailed.inc();
    const text = await serialize();
    expect(text).toMatch(/aai_warm_pool_spawn_failed_total 1/);
  });
});
