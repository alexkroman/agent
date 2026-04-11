// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, it } from "vitest";
import { parseWsUpgradeParams } from "./_ws-upgrade.ts";

describe("parseWsUpgradeParams", () => {
  it("returns defaults for URL with no query params", () => {
    const result = parseWsUpgradeParams("/websocket");
    expect(result).toEqual({ resumeFrom: undefined, skipGreeting: false });
  });

  it("extracts sessionId and sets skipGreeting", () => {
    const result = parseWsUpgradeParams("/ws?sessionId=abc-123");
    expect(result.resumeFrom).toBe("abc-123");
    expect(result.skipGreeting).toBe(true);
  });

  it("sets skipGreeting when resume param is present", () => {
    const result = parseWsUpgradeParams("/ws?resume=1");
    expect(result.resumeFrom).toBeUndefined();
    expect(result.skipGreeting).toBe(true);
  });

  it("sessionId takes precedence for resumeFrom", () => {
    const result = parseWsUpgradeParams("/ws?resume=1&sessionId=sess-42");
    expect(result.resumeFrom).toBe("sess-42");
    expect(result.skipGreeting).toBe(true);
  });

  it("handles URL with no query string", () => {
    const result = parseWsUpgradeParams("/websocket");
    expect(result.resumeFrom).toBeUndefined();
    expect(result.skipGreeting).toBe(false);
  });

  it("handles full URL with query params", () => {
    const result = parseWsUpgradeParams("ws://localhost:3000/websocket?sessionId=s1");
    expect(result.resumeFrom).toBe("s1");
    expect(result.skipGreeting).toBe(true);
  });

  it("handles empty sessionId", () => {
    const result = parseWsUpgradeParams("/ws?sessionId=");
    // Empty string from URLSearchParams.get is truthy for ?? check
    expect(result.resumeFrom).toBe("");
    expect(result.skipGreeting).toBe(true);
  });
});
