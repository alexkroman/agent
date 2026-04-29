// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { parseWsUpgradeParams } from "./ws-upgrade.ts";

describe("parseWsUpgradeParams", () => {
  test("returns defaults for URL with no query params", () => {
    expect(parseWsUpgradeParams("/websocket")).toEqual({
      resumeFrom: undefined,
      skipGreeting: false,
    });
  });

  test("extracts sessionId and sets skipGreeting", () => {
    expect(parseWsUpgradeParams("/ws?sessionId=abc-123")).toEqual({
      resumeFrom: "abc-123",
      skipGreeting: true,
    });
  });

  test("sets skipGreeting when resume param is present", () => {
    expect(parseWsUpgradeParams("/ws?resume=1")).toEqual({
      resumeFrom: undefined,
      skipGreeting: true,
    });
  });

  test("sessionId takes precedence for resumeFrom", () => {
    expect(parseWsUpgradeParams("/ws?resume=1&sessionId=sess-42")).toEqual({
      resumeFrom: "sess-42",
      skipGreeting: true,
    });
  });

  test("handles full URL with query params", () => {
    expect(parseWsUpgradeParams("ws://localhost:3000/websocket?sessionId=s1")).toEqual({
      resumeFrom: "s1",
      skipGreeting: true,
    });
  });

  test("handles empty sessionId", () => {
    // Empty string from URLSearchParams.get is truthy for ?? check
    expect(parseWsUpgradeParams("/ws?sessionId=")).toEqual({
      resumeFrom: "",
      skipGreeting: true,
    });
  });
});
