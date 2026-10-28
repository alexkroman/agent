// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { DEFAULT_SESSION_START_TIMEOUT_MS, PIPELINE_FLUSH_TIMEOUT_MS } from "./constants.ts";
import { DEFAULT_MIN_TURN_SILENCE_MS } from "./endpointing-constants.ts";
import {
  DEFAULT_FALSE_INTERRUPTION_PROMPT,
  DEFAULT_VOICE_FOCUS_THRESHOLD,
  MAX_PREEMPTIVE_SPECULATIONS_PER_UTTERANCE,
  PREEMPTIVE_QUIET_MS,
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

  test("the voice-focus threshold is a probability", () => {
    expect(DEFAULT_VOICE_FOCUS_THRESHOLD).toBeGreaterThan(0);
    expect(DEFAULT_VOICE_FOCUS_THRESHOLD).toBeLessThanOrEqual(1);
  });

  test("speculation fires inside the endpointing window, and is bounded", () => {
    // A quiet window that outlasts the wait for the final fires after the turn
    // has already committed: no head start, only a wasted request. That wait is
    // the endpointing silence PLUS STT finalization, measured at ~0.7s on
    // universal-3-5-pro (last word to commit p50 0.94s at 250ms; see
    // DEFAULT_MIN_TURN_SILENCE_MS), so the window must close well inside it.
    const finalizationMs = 700;
    expect(PREEMPTIVE_QUIET_MS).toBeGreaterThan(0);
    expect(PREEMPTIVE_QUIET_MS).toBeLessThan((DEFAULT_MIN_TURN_SILENCE_MS + finalizationMs) / 2);
    expect(MAX_PREEMPTIVE_SPECULATIONS_PER_UTTERANCE).toBeGreaterThanOrEqual(1);
  });

  test("the false-interruption prompt is a sentence for the model to act on", () => {
    expect(DEFAULT_FALSE_INTERRUPTION_PROMPT.trim().length).toBeGreaterThan(0);
  });
});
