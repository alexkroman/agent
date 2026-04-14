// Copyright 2025 the AAI authors. MIT license.
/**
 * Stability snapshot tests for SDK constants.
 *
 * These ensure that changes to numeric defaults, size limits, and other
 * magic numbers in constants.ts are always intentional and visible in diffs.
 */
import { describe, expect, test } from "vitest";
import * as constants from "./constants.ts";

describe("SDK constants stability", () => {
  test("all exported constant names", () => {
    expect(Object.keys(constants).sort()).toMatchInlineSnapshot(`
      [
        "AGENT_CSP",
        "DEFAULT_IDLE_TIMEOUT_MS",
        "DEFAULT_MAX_HISTORY",
        "DEFAULT_SESSION_START_TIMEOUT_MS",
        "DEFAULT_SHUTDOWN_TIMEOUT_MS",
        "DEFAULT_STT_SAMPLE_RATE",
        "DEFAULT_TTS_SAMPLE_RATE",
        "FETCH_TIMEOUT_MS",
        "MAX_HTML_BYTES",
        "MAX_MESSAGE_BUFFER_SIZE",
        "MAX_PAGE_CHARS",
        "MAX_TOOL_RESULT_CHARS",
        "MAX_VALUE_SIZE",
        "MAX_WS_PAYLOAD_BYTES",
        "RUN_CODE_TIMEOUT_MS",
        "TOOL_EXECUTION_TIMEOUT_MS",
        "WS_OPEN",
      ]
    `);
  });

  test("audio sample rates", () => {
    expect(constants.DEFAULT_STT_SAMPLE_RATE).toMatchInlineSnapshot("16000");
    expect(constants.DEFAULT_TTS_SAMPLE_RATE).toMatchInlineSnapshot("24000");
  });

  test("timeout values", () => {
    expect(constants.TOOL_EXECUTION_TIMEOUT_MS).toMatchInlineSnapshot("30000");
    expect(constants.DEFAULT_SESSION_START_TIMEOUT_MS).toMatchInlineSnapshot("10000");
    expect(constants.DEFAULT_IDLE_TIMEOUT_MS).toMatchInlineSnapshot("300000");
    expect(constants.FETCH_TIMEOUT_MS).toMatchInlineSnapshot("15000");
    expect(constants.RUN_CODE_TIMEOUT_MS).toMatchInlineSnapshot("5000");
    expect(constants.DEFAULT_SHUTDOWN_TIMEOUT_MS).toMatchInlineSnapshot("30000");
  });

  test("size and length limits", () => {
    expect(constants.MAX_TOOL_RESULT_CHARS).toMatchInlineSnapshot("4000");
    expect(constants.MAX_PAGE_CHARS).toMatchInlineSnapshot("10000");
    expect(constants.MAX_HTML_BYTES).toMatchInlineSnapshot("200000");
    expect(constants.MAX_VALUE_SIZE).toMatchInlineSnapshot("65536");
    expect(constants.DEFAULT_MAX_HISTORY).toMatchInlineSnapshot("200");
    expect(constants.MAX_WS_PAYLOAD_BYTES).toMatchInlineSnapshot("1048576");
    expect(constants.MAX_MESSAGE_BUFFER_SIZE).toMatchInlineSnapshot("100");
  });

  test("WebSocket constants", () => {
    expect(constants.WS_OPEN).toMatchInlineSnapshot("1");
  });

  test("AGENT_CSP value", () => {
    expect(constants.AGENT_CSP).toMatchInlineSnapshot(
      `"default-src 'self'; script-src 'self' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; connect-src 'self' wss: ws:; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; object-src 'none'; base-uri 'self'"`,
    );
  });
});
