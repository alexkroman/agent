// Copyright 2026 the AAI authors. MIT license.

import { VALID_SLUG_RE } from "@alexkroman1/aai/internal";
import { describe, expect, test } from "vitest";
import { generatedSlug, SLUG_SUFFIX_LENGTH, SLUG_SUFFIX_RE, slugSuffix } from "./slug-generate.ts";

describe("slugSuffix", () => {
  test("is lowercase base36 of the fixed length", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(slugSuffix()).toMatch(new RegExp(`^[a-z0-9]{${SLUG_SUFFIX_LENGTH}}$`));
    }
  });
});

describe("generatedSlug", () => {
  test("appends a random suffix to a prompt-derived base", () => {
    const slug = generatedSlug("contact-form");
    expect(slug).toMatch(/^contact-form-[a-z0-9]{6}$/);
    expect(VALID_SLUG_RE.test(slug)).toBe(true);
  });

  test("two calls with the same base differ (the suffix is the uniqueness)", () => {
    expect(generatedSlug("contact-form")).not.toBe(generatedSlug("contact-form"));
  });

  test("no base falls back to readable words, still suffixed", () => {
    const slug = generatedSlug();
    expect(VALID_SLUG_RE.test(slug)).toBe(true);
    expect(slug).toMatch(SLUG_SUFFIX_RE);
    // Word base, not just a bare suffix.
    expect(slug.length).toBeGreaterThan(SLUG_SUFFIX_LENGTH + 1);
  });

  test.each(["", "-", "Contact Form!", "-leading-dash"])(
    "an unusable base (%j) falls back to words",
    (base) => {
      expect(VALID_SLUG_RE.test(generatedSlug(base))).toBe(true);
    },
  );

  test("a slugless deploy gets human-id words, not a name-derived base", () => {
    // The platform knows nothing about the bundle to derive a base from.
    const slug = generatedSlug();
    expect(VALID_SLUG_RE.test(slug)).toBe(true);
    expect(slug).toMatch(SLUG_SUFFIX_RE);
    // human-id words: at least one hyphenated word ahead of the suffix.
    expect(slug.replace(SLUG_SUFFIX_RE, "")).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test("a long base is trimmed so the slug stays within the 64-char grammar", () => {
    const slug = generatedSlug(`${"word-".repeat(30)}end`);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(VALID_SLUG_RE.test(slug)).toBe(true);
    expect(slug).toMatch(SLUG_SUFFIX_RE);
  });
});
