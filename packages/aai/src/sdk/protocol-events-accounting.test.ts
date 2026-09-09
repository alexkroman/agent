// Copyright 2026 the AAI authors. MIT license.
// The two wire events that make a control auditable: `usage.updated` is what
// `AgentDef.usageLimits` is measured against, and `guardrail.blocked` is what
// the two guardrail lists leave behind. A control with no event is a control
// nobody can audit — so what these schemas admit, and the one field
// `guardrail.blocked` deliberately does NOT carry, are the claims here.

import { describe, expect, test } from "vitest";
import { MAX_TRANSCRIPT_CHARS } from "./constants.ts";
import { EVENT_ID_PREFIX } from "./protocol-event-meta.ts";
import { SessionEventSchema } from "./protocol-events.ts";
import {
  GuardrailBlockedEventSchema,
  UsageUpdatedEventSchema,
} from "./protocol-events-accounting.ts";

const META = { id: `${EVENT_ID_PREFIX}01JB2X3Y4Z5A6B7C8D9EFGHJKM`, at: 1_760_000_000_000 };

const USAGE = {
  type: "usage.updated" as const,
  meta: META,
  inputTokens: 1200,
  outputTokens: 340,
  totalTokens: 1540,
  steps: 3,
};

const BLOCKED = {
  type: "guardrail.blocked" as const,
  meta: META,
  direction: "output" as const,
  replacement: "I can't give dosage information over the phone.",
};

describe("both are ORDINARY members of the session event union", () => {
  test("each parses through SessionEventSchema, envelope and all", () => {
    // Declared in a second module for length, not promoted to a second class:
    // same envelope, same retained stream, same `agent({ events })` keys. A
    // reader discriminating on `type` must reach them without knowing that.
    expect(SessionEventSchema.parse(USAGE)).toEqual(USAGE);
    expect(SessionEventSchema.parse(BLOCKED)).toEqual(BLOCKED);
  });

  test("each carries the shared envelope and refuses one that is malformed", () => {
    expect(
      UsageUpdatedEventSchema.safeParse({ ...USAGE, meta: { id: "nope", at: 0 } }).success,
    ).toBe(false);
    expect(GuardrailBlockedEventSchema.safeParse({ ...BLOCKED, meta: undefined }).success).toBe(
      false,
    );
  });
});

describe("usage.updated", () => {
  test("accepts the four counters a cumulative report is made of", () => {
    expect(UsageUpdatedEventSchema.parse(USAGE)).toEqual(USAGE);
  });

  test("zero is legal on every counter — a session that has spent nothing", () => {
    expect(
      UsageUpdatedEventSchema.safeParse({
        ...USAGE,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        steps: 0,
      }).success,
    ).toBe(true);
  });

  test("a negative or fractional count is refused on every counter", () => {
    for (const field of ["inputTokens", "outputTokens", "totalTokens", "steps"] as const) {
      expect(UsageUpdatedEventSchema.safeParse({ ...USAGE, [field]: -1 }).success).toBe(false);
      expect(UsageUpdatedEventSchema.safeParse({ ...USAGE, [field]: 0.5 }).success).toBe(false);
    }
  });

  test("totalTokens is CARRIED, not derived — a total that is not the sum still parses", () => {
    // Deliberate: a provider reporting a total which is not the sum of its
    // parts (a reasoning or cache-read line item) is reporting what it billed,
    // and the budget honours that number rather than a reconstruction of it.
    // A schema that recomputed it would reject the very case it exists for.
    const billed = { ...USAGE, inputTokens: 10, outputTokens: 10, totalTokens: 45 };
    expect(UsageUpdatedEventSchema.parse(billed).totalTokens).toBe(45);
  });

  test("every counter is required — a partial report is not a report", () => {
    for (const field of ["inputTokens", "outputTokens", "totalTokens", "steps"] as const) {
      const { [field]: _dropped, ...rest } = USAGE;
      expect(UsageUpdatedEventSchema.safeParse(rest).success).toBe(false);
    }
  });
});

describe("guardrail.blocked", () => {
  test("says WHICH side was judged, and only those two sides", () => {
    expect(GuardrailBlockedEventSchema.parse({ ...BLOCKED, direction: "input" }).direction).toBe(
      "input",
    );
    expect(GuardrailBlockedEventSchema.parse(BLOCKED).direction).toBe("output");
    expect(GuardrailBlockedEventSchema.safeParse({ ...BLOCKED, direction: "both" }).success).toBe(
      false,
    );
  });

  test("carries the REPLACEMENT — the sentence the agent says instead", () => {
    expect(GuardrailBlockedEventSchema.parse(BLOCKED).replacement).toBe(BLOCKED.replacement);
  });

  test("does NOT carry the refused text, and a frame that adds it is stripped", () => {
    // The whole privacy decision of this event. On the output side the refused
    // text is precisely what was judged unfit to leave the agent, so putting it
    // in a frame the browser receives would deliver it after all. Unknown keys
    // strip rather than reject, which is what makes the omission enforceable
    // instead of merely conventional.
    const parsed = GuardrailBlockedEventSchema.parse({
      ...BLOCKED,
      text: "the thing the caller must not hear",
    });
    expect(parsed).toEqual(BLOCKED);
    expect(Object.keys(parsed)).not.toContain("text");
  });

  test("the replacement is bounded by the transcript cap", () => {
    // It is spoken and it is retained, so it is sized like every other piece of
    // conversation text rather than left unbounded.
    expect(
      GuardrailBlockedEventSchema.safeParse({
        ...BLOCKED,
        replacement: "x".repeat(MAX_TRANSCRIPT_CHARS),
      }).success,
    ).toBe(true);
    expect(
      GuardrailBlockedEventSchema.safeParse({
        ...BLOCKED,
        replacement: "x".repeat(MAX_TRANSCRIPT_CHARS + 1),
      }).success,
    ).toBe(false);
  });

  test("it is not an error frame, which is the reason it exists at all", () => {
    // A block is the feature working. Reported as an `error.reported` it would
    // put a banner on a screen and, emitted fatally, hang up a call the
    // guardrail had just saved.
    expect(GuardrailBlockedEventSchema.parse(BLOCKED)).not.toHaveProperty("fatal");
    expect(GuardrailBlockedEventSchema.parse(BLOCKED)).not.toHaveProperty("code");
  });
});
