// Copyright 2026 the AAI authors. MIT license.
// The fold every reader of `metrics.collected` would otherwise write: exact
// aggregates over everything, percentiles over a bounded window, and a stat
// that is ABSENT until its first sample rather than a row of zeroes.

import { describe, expect, test } from "vitest";
import { createMetricsCollector, type MetricsSample } from "./metrics-collector.ts";

const REPLY: MetricsSample = {
  interrupted: false,
  latencyMs: 900,
  stt: { endpointingMs: 300 },
  llm: { ttftMs: 450, durationMs: 1200, steps: 2, inputTokens: 1000, outputTokens: 40 },
  tts: { ttfbMs: 70, characters: 120 },
};

describe("createMetricsCollector", () => {
  test("an empty collector reports totals of zero and no distributions", () => {
    expect(createMetricsCollector().summary()).toEqual({
      replies: 0,
      interrupted: 0,
      llmInputTokens: 0,
      llmOutputTokens: 0,
      llmSteps: 0,
      ttsCharacters: 0,
    });
  });

  test("sums the totals and describes each duration", () => {
    const c = createMetricsCollector();
    c.collect(REPLY);
    c.collect({ ...REPLY, interrupted: true, latencyMs: 1500, tts: { characters: 30 } });
    const s = c.summary();
    expect(s).toMatchObject({
      replies: 2,
      interrupted: 1,
      llmInputTokens: 2000,
      llmOutputTokens: 80,
      llmSteps: 4,
      ttsCharacters: 150,
    });
    expect(s.latencyMs).toEqual({ count: 2, min: 900, max: 1500, mean: 1200, p50: 900, p95: 1500 });
    // The second reply's TTS never produced audio: one sample, not a zero.
    expect(s.ttsTtfbMs?.count).toBe(1);
  });

  test("a stage that did not happen leaves its stat absent", () => {
    const c = createMetricsCollector();
    c.collect({ interrupted: false, tts: { ttfbMs: 60, characters: 10 } });
    const s = c.summary();
    expect(s.llmTtftMs).toBeUndefined();
    expect(s.sttEndpointingMs).toBeUndefined();
    expect(s.latencyMs).toBeUndefined();
    expect(s.ttsTtfbMs?.p50).toBe(60);
  });

  test("percentiles are over the recent window; min/max/mean over everything", () => {
    const c = createMetricsCollector({ maxSamples: 10 });
    for (let i = 1; i <= 100; i++) c.collect({ interrupted: false, latencyMs: i });
    const stat = c.summary().latencyMs;
    expect(stat).toMatchObject({ count: 100, min: 1, max: 100, mean: 50.5 });
    // The window holds 91..100.
    expect(stat?.p50).toBe(95);
    expect(stat?.p95).toBe(100);
  });

  test("reset forgets everything", () => {
    const c = createMetricsCollector();
    c.collect(REPLY);
    c.reset();
    expect(c.summary().replies).toBe(0);
    expect(c.summary().latencyMs).toBeUndefined();
  });

  test("accepts a whole event, envelope and all", () => {
    const c = createMetricsCollector();
    const event = { type: "metrics.collected" as const, meta: { id: "evt_x", at: 0 }, ...REPLY };
    c.collect(event);
    expect(c.summary().replies).toBe(1);
  });
});
