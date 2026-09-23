// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { metricsEndpoint } from "./metrics-env.ts";

describe("the metrics gate", () => {
  test("opens on the generic endpoint or the metrics-specific one", () => {
    expect(metricsEndpoint({})).toBeUndefined();
    expect(metricsEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" })).toBe("http://c:4318");
    expect(metricsEndpoint({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://m:4318" })).toBe(
      "http://m:4318",
    );
    // The traces-specific variable is for traces only.
    expect(
      metricsEndpoint({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://t:4318" }),
    ).toBeUndefined();
  });

  test("OTEL_METRICS_EXPORTER=none closes it, whatever the endpoint", () => {
    expect(
      metricsEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
        OTEL_METRICS_EXPORTER: "none",
      }),
    ).toBeUndefined();
  });
});
