// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  activeSessionsUpDown,
  bargeInCounter,
  meter,
  SpanStatusCode,
  s2sConnectionDuration,
  s2sErrorCounter,
  sessionCounter,
  toolCallCounter,
  toolCallDuration,
  toolCallErrorCounter,
  tracer,
  turnCounter,
  turnStepsHistogram,
  withSpan,
} from "./telemetry.ts";

describe("telemetry", () => {
  test("tracer is defined and returns spans", () => {
    expect(tracer).toBeDefined();
    const span = tracer.startSpan("test-span");
    expect(span).toBeDefined();
    span.end();
  });

  test("meter is defined", () => {
    expect(meter).toBeDefined();
  });

  test("pre-built metrics are defined", () => {
    expect(sessionCounter).toBeDefined();
    expect(activeSessionsUpDown).toBeDefined();
    expect(turnCounter).toBeDefined();
    expect(toolCallCounter).toBeDefined();
    expect(toolCallDuration).toBeDefined();
    expect(toolCallErrorCounter).toBeDefined();
    expect(s2sConnectionDuration).toBeDefined();
    expect(s2sErrorCounter).toBeDefined();
    expect(bargeInCounter).toBeDefined();
    expect(turnStepsHistogram).toBeDefined();
  });

  test("counter add does not throw", () => {
    expect(() => sessionCounter.add(1, { agent: "test" })).not.toThrow();
    expect(() => turnCounter.add(1, { agent: "test" })).not.toThrow();
    expect(() => toolCallCounter.add(1, { agent: "test", tool: "echo" })).not.toThrow();
  });

  test("histogram record does not throw", () => {
    expect(() => toolCallDuration.record(0.5, { agent: "test", tool: "echo" })).not.toThrow();
    expect(() => s2sConnectionDuration.record(10)).not.toThrow();
  });

  test("withSpan runs sync functions", () => {
    const result = withSpan("test-sync", (span) => {
      span.setAttribute("key", "value");
      return 42;
    });
    expect(result).toBe(42);
  });

  test("withSpan runs async functions", async () => {
    const result = await withSpan("test-async", async (span) => {
      span.setAttribute("key", "value");
      return 42;
    });
    expect(result).toBe(42);
  });

  test("withSpan propagates sync errors", () => {
    expect(() =>
      withSpan("test-error", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
  });

  test("withSpan propagates async errors", async () => {
    await expect(
      withSpan("test-async-error", async () => {
        throw new Error("async boom");
      }),
    ).rejects.toThrow("async boom");
  });

  test("SpanStatusCode is re-exported", () => {
    expect(SpanStatusCode.OK).toBe(1);
    expect(SpanStatusCode.ERROR).toBe(2);
  });
});
