// Copyright 2026 the AAI authors. MIT license.
// `metrics.collected` is an ordinary member of the session event union, and
// every stage is optional: absent means "did not happen", never zero.

import { describe, expect, test } from "vitest";
import { EVENT_ID_PREFIX } from "./protocol-event-meta.ts";
import { SESSION_EVENT_TYPES, SessionEventSchema } from "./protocol-events.ts";
import { MetricsCollectedEventSchema } from "./protocol-events-metrics.ts";

const META = { id: `${EVENT_ID_PREFIX}01JB2X3Y4Z5A6B7C8D9EFGHJKM`, at: 1_760_000_000_000 };

const FULL = {
  type: "metrics.collected" as const,
  meta: META,
  interrupted: false,
  latencyMs: 910,
  stt: { endpointingMs: 320 },
  llm: { ttftMs: 480, durationMs: 1300, steps: 1, inputTokens: 900, outputTokens: 30 },
  tts: { ttfbMs: 66, characters: 84 },
};

describe("metrics.collected", () => {
  test("parses through SessionEventSchema and is a known type", () => {
    expect(SessionEventSchema.parse(FULL)).toEqual(FULL);
    expect(SESSION_EVENT_TYPES.has("metrics.collected")).toBe(true);
  });

  test("a greeting — no caller turn, no model — needs only TTS", () => {
    const greeting = {
      type: "metrics.collected" as const,
      meta: META,
      interrupted: false,
      tts: { ttfbMs: 70, characters: 40 },
    };
    expect(MetricsCollectedEventSchema.parse(greeting)).toEqual(greeting);
  });

  test("refuses negative and fractional durations", () => {
    expect(MetricsCollectedEventSchema.safeParse({ ...FULL, latencyMs: -1 }).success).toBe(false);
    expect(
      MetricsCollectedEventSchema.safeParse({ ...FULL, tts: { ttfbMs: 1.5, characters: 1 } })
        .success,
    ).toBe(false);
  });

  test("interrupted is required: a reader must never guess it", () => {
    const { interrupted: _, ...rest } = FULL;
    expect(MetricsCollectedEventSchema.safeParse(rest).success).toBe(false);
  });
});
