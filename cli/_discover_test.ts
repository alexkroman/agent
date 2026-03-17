// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { DEFAULT_SERVER, generateSlug } from "./_discover.ts";

describe("generateSlug", () => {
  test("returns a lowercase hyphenated string", () => {
    const slug = generateSlug();
    expect(slug).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  });

  test("generates different slugs on each call", () => {
    const slugs = new Set(Array.from({ length: 10 }, () => generateSlug()));
    // With 10 calls we should get at least 2 unique values
    expect(slugs.size > 1).toBe(true);
  });
});

test("DEFAULT_SERVER", () => {
  expect(DEFAULT_SERVER).toBe("https://aai-agent.fly.dev");
});
