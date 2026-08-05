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
    // Slicing from the first "?" (not split[1]) keeps the whole query string,
    // so a param AFTER one whose value contains "?" is still seen.
    // (`sessionId` can no longer carry a literal "?" — see the shape guard
    // below — so the truncation this pins is shown on another param.)
    expect(parseWsUpgradeParams("/ws?other=a?b&resume=1")).toEqual({ skipGreeting: true });
  });

  // The id becomes the key of the runtime's session and ctx.state maps, and
  // presenting it claims (and evicts) that session — on a PUBLIC, auth-free
  // endpoint. Measured before this guard: a 16 000-character id was accepted
  // verbatim, as were traversal- and NUL-shaped strings.
  test("ignores an id that could not have been minted by the server", () => {
    for (const bad of [
      "x".repeat(129),
      "../../etc/passwd",
      "a/../../admin",
      "'; DROP TABLE agents;--",
      "has space",
      "nul\u0000byte",
      "emoji-🙂",
    ]) {
      const out = parseWsUpgradeParams(`/websocket?sessionId=${encodeURIComponent(bad)}`);
      // Soft, and labelled with the shape: a loosened guard usually admits a
      // whole class of ids, and which ones got through is the finding.
      expect.soft(out.resumeFrom, JSON.stringify(bad)).toBeUndefined();
      // Not resuming, so the greeting must still play.
      expect.soft(out.skipGreeting, JSON.stringify(bad)).toBe(false);
    }
  });

  test("accepts the shapes the server actually mints", () => {
    for (const ok of [crypto.randomUUID(), "a", "A-Z_0-9-abc", "x".repeat(128)]) {
      expect.soft(parseWsUpgradeParams(`/websocket?sessionId=${ok}`).resumeFrom, ok).toBe(ok);
    }
  });
});
