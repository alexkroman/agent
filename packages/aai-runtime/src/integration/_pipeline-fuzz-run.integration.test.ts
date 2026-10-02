// Copyright 2026 the AAI authors. MIT license.
/**
 * One hand-written run through the pipeline fuzz's driver, and the harness that
 * collects unhandled rejections across a property. Integration tier: `runOne`
 * drives a real pipeline transport over the fakes, in memory.
 */

import { describe, expect, test } from "vitest";
import type { RunInput } from "./_pipeline-fuzz-input.ts";
import { installHarness, runOne } from "./_pipeline-fuzz-run.ts";

/** A plain conversation: the user speaks, the agent answers in text, twice. */
const CONVERSATION: RunInput = {
  steps: [
    { action: "sttPartial", opener: 1, pauseMs: 1 },
    { action: "sttFinal", opener: 1, pauseMs: 2 },
    { action: "ttsAudio", opener: 0, pauseMs: 2 },
    { action: "sendUserAudio", opener: 0, pauseMs: 1 },
    { action: "sttFinal", opener: 3, pauseMs: 2 },
    { action: "ttsAudio", opener: 0, pauseMs: 2 },
  ],
  script: ["text", "text", "text", "text"],
  tools: [{ kind: "ok" }],
  refusals: [false, false, false, false],
  preemptiveGeneration: false,
};

describe("runOne", () => {
  test("a legal conversation reports no violations and records its coverage", async () => {
    const harness = installHarness();
    try {
      const violations = await runOne(CONVERSATION, CONVERSATION.steps.length, harness.cov);
      expect(violations).toEqual([]);
      expect(harness.unhandled).toEqual([]);
    } finally {
      harness.dispose();
    }
    expect(harness.cov.replyStarted ?? 0).toBeGreaterThan(0);
    expect(harness.cov.llmRequest ?? 0).toBeGreaterThan(0);
  });
});

describe("installHarness", () => {
  test("listens for unhandled rejections until disposed", () => {
    const before = process.listenerCount("unhandledRejection");
    const harness = installHarness();
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
    process.emit("unhandledRejection", new Error("nobody awaited me"), Promise.resolve());
    expect(harness.unhandled).toEqual(["Error: nobody awaited me"]);
    harness.dispose();
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });
});
