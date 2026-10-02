// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { DEFAULT_SESSION_START_TIMEOUT_MS, PIPELINE_FLUSH_TIMEOUT_MS } from "./constants.ts";
import {
  DEFAULT_FALSE_INTERRUPTION_PROMPT,
  DEFAULT_VOICE_FOCUS_THRESHOLD,
  MAX_PREEMPTIVE_SPECULATIONS_PER_UTTERANCE,
  PREEMPTIVE_CONFIDENCE_THRESHOLD,
  STT_CONNECT_MAX_RETRIES,
  STT_CONNECT_RETRY_DELAY_MS,
  STT_CONNECT_TIMEOUT_MS,
  STT_FRAME_FLOOR_MS,
  STT_FRAME_MAX_MS,
  STT_FRAME_TARGET_MS,
  TTS_CANCEL_ACK_TIMEOUT_MS,
} from "./pipeline-tuning-constants.ts";

describe("pipeline tuning", () => {
  test("the STT connect worst case fits inside session.start()'s deadline", () => {
    // Otherwise a connect failure can only ever surface as the vaguer start timeout.
    const worstCase =
      (STT_CONNECT_MAX_RETRIES + 1) * STT_CONNECT_TIMEOUT_MS +
      STT_CONNECT_MAX_RETRIES * STT_CONNECT_RETRY_DELAY_MS;
    expect(worstCase).toBeLessThan(DEFAULT_SESSION_START_TIMEOUT_MS);
  });

  test("the STT frame sizes are ordered floor < target < max", () => {
    expect(STT_FRAME_FLOOR_MS).toBeLessThan(STT_FRAME_TARGET_MS);
    expect(STT_FRAME_TARGET_MS).toBeLessThan(STT_FRAME_MAX_MS);
  });

  test("a TTS cancel ack is waited for well under the flush timeout", () => {
    expect(TTS_CANCEL_ACK_TIMEOUT_MS).toBeLessThan(PIPELINE_FLUSH_TIMEOUT_MS);
  });

  test("the thresholds are probabilities, and speculation is bounded", () => {
    for (const threshold of [DEFAULT_VOICE_FOCUS_THRESHOLD, PREEMPTIVE_CONFIDENCE_THRESHOLD]) {
      expect(threshold).toBeGreaterThan(0);
      expect(threshold).toBeLessThanOrEqual(1);
    }
    expect(MAX_PREEMPTIVE_SPECULATIONS_PER_UTTERANCE).toBeGreaterThanOrEqual(1);
  });

  test("the false-interruption prompt is a sentence for the model to act on", () => {
    expect(DEFAULT_FALSE_INTERRUPTION_PROMPT.trim().length).toBeGreaterThan(0);
  });
});
