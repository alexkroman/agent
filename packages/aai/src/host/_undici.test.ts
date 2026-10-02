// Copyright 2026 the AAI authors. MIT license.
import { Agent, fetch as undiciFetch } from "undici";
import { describe, expect, test } from "vitest";
import { asDispatcher, pinnedFetch } from "./_undici.ts";

describe("pinnedFetch", () => {
  test("is the undici package's fetch — the one its Agent can dispatch for", () => {
    expect(pinnedFetch).toBe(undiciFetch);
  });

  test("is NOT the runtime's global fetch, whose bundled undici is another major", () => {
    expect(pinnedFetch).not.toBe(globalThis.fetch);
  });
});

describe("asDispatcher", () => {
  test("hands back the same Agent, re-typed and not wrapped", async () => {
    const agent = new Agent();
    try {
      expect(asDispatcher(agent)).toBe(agent);
    } finally {
      await agent.close();
    }
  });
});
