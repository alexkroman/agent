// Copyright 2025 the AAI authors. MIT license.
import { metrics } from "@opentelemetry/api";
import { describe, expect, test } from "vitest";
import { serialize, serializeForAgent } from "./metrics.ts";

const meter = metrics.getMeter("aai-server-test");

describe("metrics", () => {
  test("serialize returns Prometheus-like text format", async () => {
    const counter = meter.createCounter("test_total", { description: "test counter" });
    counter.add(1);
    const output = await serialize();
    expect(output).toContain("# HELP test_total test counter");
    expect(output).toContain("test_total");
  });

  test("serializeForAgent filters by agent label", async () => {
    const counter = meter.createCounter("req_total", {
      description: "requests",
    });
    counter.add(1, { agent: "my-agent" });
    counter.add(1, { agent: "other-agent" });
    counter.add(1, { agent: "my-agent" });

    const output = await serializeForAgent("my-agent");
    expect(output).toContain("req_total");
    expect(output).not.toContain("other-agent");
  });

  test("serializeForAgent returns empty metrics for unknown agent", async () => {
    const counter = meter.createCounter("req2_total", {
      description: "requests",
    });
    counter.add(1, { agent: "real-agent" });

    const output = await serializeForAgent("nonexistent");
    expect(output).toContain("# HELP req2_total");
    expect(output).not.toContain("real-agent");
  });

  test("createGauge can inc and dec", async () => {
    const gauge = meter.createUpDownCounter("active_sessions_test", {
      description: "active",
    });
    gauge.add(1, { agent: "a" });
    gauge.add(1, { agent: "a" });
    gauge.add(-1, { agent: "a" });

    const output = await serializeForAgent("a");
    expect(output).toContain("active_sessions_test");
  });

  test("createHistogram observes values with bucket lines", async () => {
    const hist = meter.createHistogram("duration_seconds_test", {
      description: "duration",
      advice: { explicitBucketBoundaries: [0.1, 0.5, 1] },
    });
    hist.record(0.3, { agent: "a" });

    const output = await serializeForAgent("a");
    expect(output).toContain("duration_seconds_test_bucket");
    expect(output).toContain('le="+Inf"');
    expect(output).toContain("duration_seconds_test_sum");
    expect(output).toContain("duration_seconds_test_count");
  });

  test("serialize includes histogram buckets for all agents", async () => {
    const hist = meter.createHistogram("latency_test", {
      description: "latency",
      advice: { explicitBucketBoundaries: [0.5, 1] },
    });
    hist.record(0.7, { agent: "b" });

    const output = await serialize();
    expect(output).toContain("# TYPE latency_test histogram");
    expect(output).toContain("latency_test_bucket");
    expect(output).toContain("latency_test_count");
    expect(output).toContain("latency_test_sum");
  });

  test("serialize counter with labels includes label string", async () => {
    const counter = meter.createCounter("labeled_total", {
      description: "labeled",
    });
    counter.add(1, { agent: "x", method: "GET" });

    const output = await serialize();
    expect(output).toContain('agent="x"');
    expect(output).toContain('method="GET"');
  });

  test("non-string attribute values are converted to strings", async () => {
    const counter = meter.createCounter("nonstr_total", {
      description: "non-string attrs",
    });
    counter.add(1, { agent: "a", status: 200 });

    const output = await serializeForAgent("a");
    expect(output).toContain('status="200"');
    expect(output).not.toContain("[object");
  });
});
