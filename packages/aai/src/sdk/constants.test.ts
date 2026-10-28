// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  DEFAULT_BUILTIN_TOOLS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_RELAY_TOOL_TIMEOUT_MS,
  DEFAULT_SESSION_START_TIMEOUT_MS,
  DEFAULT_STT_SAMPLE_RATE,
  DEFAULT_TTS_SAMPLE_RATE,
  MAX_AUDIO_SAMPLE_RATE,
  MAX_TOOL_RESULT_CHARS,
  SESSION_KEEPALIVE_INTERVAL_MS,
  SESSION_RESUME_GRACE_MS,
  TOOL_EXECUTION_TIMEOUT_MS,
  TOOL_RESULT_TRUNCATION_MARKER,
  WS_NORMAL_CLOSURE,
  WS_OPEN,
} from "./constants.ts";
import { agent } from "./define.ts";
import { DEFAULT_MAX_STEPS } from "./tool-loop-constants.ts";

describe("constants", () => {
  /**
   * Pinned as an EQUALITY, not a containment.
   *
   * The only other assertion on this constant is
   * `expect.arrayContaining([...DEFAULT_BUILTIN_TOOLS])` in `runtime.test.ts`,
   * which was vacuously true while the list was empty — so nothing checked the
   * default at all, and three separate docs (including the scaffold guide
   * shipped to users) went on describing a four-tool "cognitive set" default
   * long after it was removed. The default is `think` alone; every other
   * built-in is opt-in by name.
   */
  test("DEFAULT_BUILTIN_TOOLS is exactly `think` — the rest are opt-in by name", () => {
    expect(DEFAULT_BUILTIN_TOOLS).toEqual(["think"]);
    expect(agent({ name: "t" }).builtinTools).toBeUndefined();
  });

  test("the WebSocket literals are the protocol's own numbers", () => {
    // `WebSocket.OPEN` and close code 1000 (RFC 6455), spelled without a DOM lib.
    expect(WS_OPEN).toBe(1);
    expect(WS_NORMAL_CLOSURE).toBe(1000);
  });

  test("both default sample rates are rates the protocol accepts", () => {
    expect(DEFAULT_STT_SAMPLE_RATE).toBeLessThanOrEqual(MAX_AUDIO_SAMPLE_RATE);
    expect(DEFAULT_TTS_SAMPLE_RATE).toBeLessThanOrEqual(MAX_AUDIO_SAMPLE_RATE);
  });

  test("a relayed tool may run longer than a host-side one, never shorter", () => {
    expect(DEFAULT_RELAY_TOOL_TIMEOUT_MS).toBeGreaterThanOrEqual(TOOL_EXECUTION_TIMEOUT_MS);
  });

  test("the keepalive fires well inside the idle timeout and the resume grace", () => {
    expect(SESSION_KEEPALIVE_INTERVAL_MS).toBeLessThan(DEFAULT_IDLE_TIMEOUT_MS);
    expect(SESSION_KEEPALIVE_INTERVAL_MS).toBeLessThan(SESSION_RESUME_GRACE_MS);
    expect(DEFAULT_SESSION_START_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test("the truncation marker fits inside the result cap it is charged against", () => {
    expect(TOOL_RESULT_TRUNCATION_MARKER.length).toBeLessThan(MAX_TOOL_RESULT_CHARS);
  });

  test("re-exports the split-out modules' values unchanged", () => {
    expect(DEFAULT_MAX_STEPS).toBe(10);
  });
});

describe("protocol constants", () => {
  test("DEFAULT_STT_SAMPLE_RATE is 16000", () => {
    expect(DEFAULT_STT_SAMPLE_RATE).toBe(16_000);
  });

  test("DEFAULT_TTS_SAMPLE_RATE is 24000", () => {
    expect(DEFAULT_TTS_SAMPLE_RATE).toBe(24_000);
  });

  test("TOOL_EXECUTION_TIMEOUT_MS is 30000", () => {
    expect(TOOL_EXECUTION_TIMEOUT_MS).toBe(30_000);
  });
});
