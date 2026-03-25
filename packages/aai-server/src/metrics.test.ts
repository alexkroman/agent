// Copyright 2025 the AAI authors. MIT license.
import { afterEach, describe, expect, test } from "vitest";
import { _internals, serialize, serializeForAgent } from "./metrics.ts";

const { createCounter, createGauge, createHistogram, registry } = _internals;

afterEach(() => {
  registry.clear();
});

describe("metrics", () => {
  test("serialize returns Prometheus text format", async () => {
    const counter = createCounter("test_total", { help: "test counter" });
    counter.inc();
    const output = await serialize();
    expect(output).toContain("# HELP test_total test counter");
    expect(output).toContain("# TYPE test_total counter");
    expect(output).toContain("test_total 1");
  });

  test("serializeForAgent filters by agent label", async () => {
    const counter = createCounter("req_total", {
      help: "requests",
      labelNames: ["agent"],
    });
    counter.inc({ agent: "my-agent" });
    counter.inc({ agent: "other-agent" });
    counter.inc({ agent: "my-agent" });

    const output = await serializeForAgent("my-agent");
    expect(output).toContain("req_total 2");
    expect(output).not.toContain("other-agent");
  });

  test("serializeForAgent returns empty metrics for unknown agent", async () => {
    const counter = createCounter("req2_total", {
      help: "requests",
      labelNames: ["agent"],
    });
    counter.inc({ agent: "real-agent" });

    const output = await serializeForAgent("nonexistent");
    expect(output).toContain("# HELP req2_total");
    expect(output).not.toContain("real-agent");
  });

  test("createGauge can inc and dec", async () => {
    const gauge = createGauge("active_sessions", {
      help: "active",
      labelNames: ["agent"],
    });
    gauge.inc({ agent: "a" });
    gauge.inc({ agent: "a" });
    gauge.dec({ agent: "a" });

    const output = await serializeForAgent("a");
    expect(output).toContain("active_sessions 1");
  });

  test("createHistogram observes values", async () => {
    const hist = createHistogram("duration_seconds", {
      help: "duration",
      buckets: [0.1, 0.5, 1],
      labelNames: ["agent"],
    });
    hist.observe({ agent: "a" }, 0.3);

    const output = await serializeForAgent("a");
    expect(output).toContain("duration_seconds_count 1");
    expect(output).toContain("duration_seconds_sum 0.3");
  });
});
