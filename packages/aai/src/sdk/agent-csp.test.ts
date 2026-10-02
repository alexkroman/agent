// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { AGENT_CSP } from "./agent-csp.ts";

/** The header as `directive -> sources`, so a case asserts a directive, not a substring. */
function directives(header: string): Map<string, string[]> {
  return new Map(
    header.split(";").map((part) => {
      const [name = "", ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

describe("AGENT_CSP", () => {
  const policy = directives(AGENT_CSP);

  test("names each directive once", () => {
    const names = AGENT_CSP.split(";").map((part) => part.trim().split(/\s+/)[0]);
    expect(new Set(names).size).toBe(names.length);
  });

  test("lets media load from a blob: or data: URL — an upload is played through one", () => {
    expect(policy.get("media-src")).toEqual(expect.arrayContaining(["'self'", "blob:", "data:"]));
  });

  test("falls back to the page's own origin and refuses plugins", () => {
    expect(policy.get("default-src")).toEqual(["'self'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'self'"]);
  });

  test("allows the session's WebSocket", () => {
    expect(policy.get("connect-src")).toEqual(expect.arrayContaining(["wss:", "ws:"]));
  });
});
