// Copyright 2026 the AAI authors. MIT license.
// The real OTel pipeline, end to end in memory: a frame recorded through the
// sink registry reaches an exporter as a histogram and a counter, with the
// service name on the resource — and a shutdown unregisters the sink.

import {
  AggregationTemporality,
  InMemoryMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { describe, expect, onTestFinished, test } from "vitest";
import { loadOtelMetricPeers, startMetricsOtel } from "./_metrics-otel.ts";
import { recordSessionMetrics } from "./metrics-sink.ts";

function metricNames(batches: ResourceMetrics[]): string[] {
  return batches.flatMap((b) =>
    b.scopeMetrics.flatMap((s) => s.metrics.map((m) => m.descriptor.name)),
  );
}

describe("startMetricsOtel", () => {
  test("a recorded frame is exported as OTLP metrics under the service name", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const handle = startMetricsOtel(await loadOtelMetricPeers(), "concierge", {}, () => exporter);
    onTestFinished(() => handle.shutdown());

    recordSessionMetrics(
      {
        type: "metrics.collected",
        meta: { id: "evt_01JB2X3Y4Z5A6B7C8D9EFGHJKM", at: 0 },
        interrupted: false,
        latencyMs: 900,
        llm: { ttftMs: 400, durationMs: 1200, steps: 1, inputTokens: 10, outputTokens: 2 },
      },
      { agent: "Concierge", sessionId: "s-1" },
    );
    await handle.forceFlush();

    const batches = exporter.getMetrics();
    expect(metricNames(batches)).toEqual(
      expect.arrayContaining([
        "aai.replies",
        "aai.reply.latency",
        "aai.llm.time_to_first_token",
        "aai.llm.tokens",
      ]),
    );
    expect(batches[0]?.resource.attributes["service.name"]).toBe("concierge");
  });

  test("shutdown unregisters the sink, and is idempotent", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const handle = startMetricsOtel(await loadOtelMetricPeers(), "svc", {}, () => exporter);
    await handle.shutdown();
    await handle.shutdown();
    exporter.reset();
    // Recording after shutdown reaches no provider and throws nothing.
    expect(() =>
      recordSessionMetrics(
        { type: "metrics.collected", meta: { id: "evt_x", at: 0 }, interrupted: false },
        { agent: "a", sessionId: "s" },
      ),
    ).not.toThrow();
    expect(exporter.getMetrics()).toEqual([]);
  });
});
