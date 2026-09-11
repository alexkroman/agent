// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  DEAD_AIR_COVER_MAX_MS,
  DEAD_AIR_COVER_PHRASES,
  DEAD_AIR_OPENING_PHRASE,
  DEAD_AIR_TOOL_COVER_MS,
  DEFAULT_DEAD_AIR_COVER_MS,
} from "./dead-air-constants.ts";
import { DEFAULT_MIN_TURN_SILENCE_MS } from "./endpointing-constants.ts";

describe("dead-air cover windows", () => {
  // The reason the tool window exists. The turn-open window is armed on a
  // condition true of EVERY turn, so it can only find the silent ones by
  // waiting long enough to be sure; a `tool-call` part is true of exactly the
  // turns that go quiet. If these ever converge, the tool window has stopped
  // buying anything and the branch arming it should go.
  test("the tool window is materially shorter than the turn-open one", () => {
    expect(DEAD_AIR_TOOL_COVER_MS).toBeLessThan(DEFAULT_DEAD_AIR_COVER_MS);
    expect(DEAD_AIR_TOOL_COVER_MS * 2).toBeLessThan(DEFAULT_DEAD_AIR_COVER_MS);
  });

  // The constraint the value was CHOSEN against, in the caller's frame rather
  // than the agent's. Cover is armed after endpointing has already elapsed, so
  // what the caller waits is the sum — and a simulated caller on tau2-bench
  // abandons the turn at 5.0s. The turn-open window fails this by ~1.8s, which
  // is why 113 of 123 firings on a 114-task run were too late to matter.
  const CALLER_GIVES_UP_MS = 5000;
  test("a tool-armed filler lands inside the caller's patience; the turn-open one does not", () => {
    expect(DEFAULT_MIN_TURN_SILENCE_MS + DEAD_AIR_TOOL_COVER_MS).toBeLessThan(CALLER_GIVES_UP_MS);
    expect(DEFAULT_MIN_TURN_SILENCE_MS + DEFAULT_DEAD_AIR_COVER_MS).toBeGreaterThan(
      CALLER_GIVES_UP_MS,
    );
  });

  // The backoff doubles from whichever base armed it and flattens at the
  // ceiling. A ceiling below the base would clamp the first window BELOW its
  // own base — the trap `DEAD_AIR_COVER_MAX_MS` documents.
  test("the ceiling is above both bases, so neither is clamped below itself", () => {
    expect(DEAD_AIR_COVER_MAX_MS).toBeGreaterThan(DEFAULT_DEAD_AIR_COVER_MS);
    expect(DEAD_AIR_COVER_MAX_MS).toBeGreaterThan(DEAD_AIR_TOOL_COVER_MS);
  });
});

describe("dead-air cover phrases", () => {
  // The opening phrase describes work the caller never heard START ("I'm
  // checking on this."); the cycle phrases describe work CONTINUING. Sharing
  // one string would make the second filler sound like the first repeated.
  test("the opening phrase is not one of the cycle phrases", () => {
    expect(DEAD_AIR_COVER_PHRASES).not.toContain(DEAD_AIR_OPENING_PHRASE);
  });

  test("every phrase is short, speakable, and carries no markup", () => {
    for (const phrase of [DEAD_AIR_OPENING_PHRASE, ...DEAD_AIR_COVER_PHRASES]) {
      expect(phrase.trim()).toBe(phrase);
      expect(phrase.length).toBeLessThan(60);
      // Filler is spoken aloud by TTS — anything unspeakable is a defect.
      expect(phrase).not.toMatch(/[*_#`<>[\]{}]/);
    }
  });

  test("there is more than one cycle phrase, so a chain does not repeat itself", () => {
    expect(DEAD_AIR_COVER_PHRASES.length).toBeGreaterThan(1);
    expect(new Set(DEAD_AIR_COVER_PHRASES).size).toBe(DEAD_AIR_COVER_PHRASES.length);
  });
});
