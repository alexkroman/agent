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

  test("treats an empty sessionId as absent (no resume, greeting kept)", () => {
    // An empty `?sessionId=` is not a resumable session; it must not become a
    // defined-but-empty resumeFrom (which would also suppress the greeting).
    expect(parseWsUpgradeParams("/ws?sessionId=")).toEqual({ skipGreeting: false });
  });

  test("does not truncate a query value containing a literal '?'", () => {
    // Slicing from the first "?" (not split[1]) keeps the whole query string.
    expect(parseWsUpgradeParams("/ws?sessionId=a?b")).toEqual({
      resumeFrom: "a?b",
      skipGreeting: true,
    });
  });
});
