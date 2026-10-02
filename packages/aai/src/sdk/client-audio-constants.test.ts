// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  CLIENT_AUDIO_LEAD_MS,
  MAX_PLAYBACK_BUFFERED_MS,
  MIC_SEND_MAX_BUFFERED_BYTES,
  PACER_BURST_MS,
  PLAYBACK_BUFFER_SECONDS,
  PLAYBACK_DONE_MAX_WAIT_MS,
  PLAYBACK_DONE_POLL_MS,
  PLAYBACK_FILL_MS,
} from "./client-audio-constants.ts";
import { DEFAULT_STT_SAMPLE_RATE } from "./constants.ts";

describe("client audio budgets", () => {
  test("the server's lead stays above the client's fill, even at the bottom of a burst", () => {
    expect(CLIENT_AUDIO_LEAD_MS).toBeGreaterThan(PLAYBACK_FILL_MS);
    expect(CLIENT_AUDIO_LEAD_MS - PACER_BURST_MS).toBeGreaterThan(PLAYBACK_FILL_MS);
  });

  test("waiting for playback to finish outlasts a full buffer, polled more than once", () => {
    expect(PLAYBACK_DONE_MAX_WAIT_MS).toBeGreaterThan(PLAYBACK_BUFFER_SECONDS * 1000);
    expect(PLAYBACK_DONE_POLL_MS).toBeLessThan(PLAYBACK_DONE_MAX_WAIT_MS);
  });

  test("the playback buffer fits under the wire cap on buffered playback", () => {
    expect(PLAYBACK_BUFFER_SECONDS * 1000).toBeLessThanOrEqual(MAX_PLAYBACK_BUFFERED_MS);
  });

  test("the mic backpressure threshold is about two seconds of 16 kHz PCM16", () => {
    const seconds = MIC_SEND_MAX_BUFFERED_BYTES / (DEFAULT_STT_SAMPLE_RATE * 2);
    expect(seconds).toBeGreaterThan(1.5);
    expect(seconds).toBeLessThan(2.5);
  });
});
