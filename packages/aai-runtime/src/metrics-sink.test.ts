// Copyright 2026 the AAI authors. MIT license.
// The process-wide metrics sinks: a registry keyed on `globalThis` (a deployed
// guest has two copies of this package), a sink that cannot hurt a session,
// and the OTel sink's instrument mapping — asserted against a recording meter,
// so the claims are about names, units and attributes rather than an SDK.

import type { MetricsCollectedEvent } from "@alexkroman1/aai";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import {
  type OtelMeterLike,
  otelMetricsSink,
  recordSessionMetrics,
  registerMetricsSink,
} from "./metrics-sink.ts";

const EVENT: MetricsCollectedEvent = {
  type: "metrics.collected",
  meta: { id: "evt_01JB2X3Y4Z5A6B7C8D9EFGHJKM", at: 0 },
  interrupted: false,
  latencyMs: 910,
  stt: { endpointingMs: 320 },
  llm: { ttftMs: 480, durationMs: 1300, steps: 1, inputTokens: 900, outputTokens: 30 },
  tts: { ttfbMs: 66, characters: 84 },
};
const CTX = { agent: "Concierge", sessionId: "s-1" };

function recordingMeter() {
  const points: { name: string; value: number; attrs: unknown }[] = [];
  const units = new Map<string, string | undefined>();
  const meter: OtelMeterLike = {
    createHistogram: (name, opts) => {
      units.set(name, opts?.unit);
      return { record: (value, attrs) => points.push({ name, value, attrs }) };
    },
    createCounter: (name, opts) => {
      units.set(name, opts?.unit);
      return { add: (value, attrs) => points.push({ name, value, attrs }) };
    },
  };
  return { meter, points, units };
}

describe("registerMetricsSink", () => {
  test("every registered sink sees every frame, until it is removed", () => {
    const record = vi.fn();
    const remove = registerMetricsSink({ record });
    onTestFinished(remove);
    recordSessionMetrics(EVENT, CTX);
    expect(record).toHaveBeenCalledWith(EVENT, CTX);
    remove();
    recordSessionMetrics(EVENT, CTX);
    expect(record).toHaveBeenCalledTimes(1);
  });

  test("a throwing sink is dropped for that frame and never reaches the session", () => {
    const after = vi.fn();
    const a = registerMetricsSink({
      record: () => {
        throw new Error("collector down");
      },
    });
    const b = registerMetricsSink({ record: after });
    onTestFinished(() => {
      a();
      b();
    });
    expect(() => recordSessionMetrics(EVENT, CTX)).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  test("the registry is shared by a SECOND copy of this module", async () => {
    // What a deployed guest is: the harness's copy registers, the bundle's
    // copy records. `vi.resetModules()` is how one process holds two.
    const record = vi.fn();
    const remove = registerMetricsSink({ record });
    onTestFinished(remove);
    vi.resetModules();
    const other = await import("./metrics-sink.ts");
    other.recordSessionMetrics(EVENT, CTX);
    expect(record).toHaveBeenCalledTimes(1);
  });
});

describe("otelMetricsSink", () => {
  test("maps every measurement onto its instrument, labelled by agent", () => {
    const { meter, points, units } = recordingMeter();
    otelMetricsSink(meter).record(EVENT, CTX);
    const agent = { "aai.agent": "Concierge" };
    expect(points).toEqual([
      { name: "aai.replies", value: 1, attrs: { ...agent, "aai.reply.interrupted": false } },
      { name: "aai.reply.latency", value: 910, attrs: agent },
      { name: "aai.stt.endpointing_delay", value: 320, attrs: agent },
      { name: "aai.llm.time_to_first_token", value: 480, attrs: agent },
      { name: "aai.llm.duration", value: 1300, attrs: agent },
      { name: "aai.llm.tokens", value: 900, attrs: { ...agent, "aai.token.type": "input" } },
      { name: "aai.llm.tokens", value: 30, attrs: { ...agent, "aai.token.type": "output" } },
      { name: "aai.tts.time_to_first_byte", value: 66, attrs: agent },
      { name: "aai.tts.characters", value: 84, attrs: agent },
    ]);
    expect(units.get("aai.reply.latency")).toBe("ms");
    // No session id anywhere: one series per call is a cardinality bomb.
    expect(JSON.stringify(points)).not.toContain("s-1");
  });

  test("a stage that did not happen records nothing, not a zero", () => {
    const { meter, points } = recordingMeter();
    otelMetricsSink(meter).record(
      { type: "metrics.collected", meta: EVENT.meta, interrupted: true },
      CTX,
    );
    expect(points.map((p) => p.name)).toEqual(["aai.replies"]);
  });
});
