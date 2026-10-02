// Copyright 2026 the AAI authors. MIT license.
/**
 * Each loader reaches the module whose entry points `tracing.ts` calls — the
 * seam is only worth having if its default is the real load.
 */

import { describe, expect, test } from "vitest";
import { otelModules } from "./_otel-load.ts";

describe("otelModules", () => {
  test("the tracing loader resolves the span-export module", async () => {
    const otel = await otelModules.tracing();
    expect(otel.loadOtelPeers).toBeTypeOf("function");
    expect(otel.startTracingOtel).toBeTypeOf("function");
  });

  test("the metrics loader resolves the metric-export module", async () => {
    const otel = await otelModules.metrics();
    expect(otel.loadOtelMetricPeers).toBeTypeOf("function");
    expect(otel.startMetricsOtel).toBeTypeOf("function");
  });
});
