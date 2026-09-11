// Copyright 2026 the AAI authors. MIT license.
// Rendering the digest into the fast tier's prompt. UNIT tier — a pure
// function over a plain record, which is the whole reason the digest is one.

import { MAX_STATE_DIGEST_CHARS } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { createDigestStore } from "./digest.ts";
import { DIGEST_HEADING, renderDigestSection } from "./digest-prompt.ts";

describe("renderDigestSection", () => {
  test("an empty digest renders NOTHING, so the prompt is byte-identical", () => {
    // Load-bearing: `SessionSystemPrompt.resolve` returns the base string
    // itself for an empty suffix, which is what makes the on-arm before the
    // first tool call comparable to the off-arm at all.
    expect(renderDigestSection(createDigestStore().read())).toBe("");
  });

  test("pending work is stated as NOT done, with the no-claim rule", () => {
    const digest = createDigestStore();
    digest.summarize("Looking up the order now.");
    digest.open("change_address", "w1");
    const text = renderDigestSection(digest.read());
    expect(text).toContain(DIGEST_HEADING);
    expect(text).toContain("Looking up the order now.");
    expect(text).toContain("change_address: IN PROGRESS");
    expect(text).toContain("do not tell the caller it is finished");
  });

  test("a completed entry says so, and carries its note", () => {
    const digest = createDigestStore();
    digest.open("change_address", "w1");
    digest.settle("w1", "done", "confirmed on screen");
    const text = renderDigestSection(digest.read());
    expect(text).toContain("change_address: completed and confirmed (confirmed on screen)");
  });

  test("an unverified entry is NOT described as confirmed", () => {
    const digest = createDigestStore();
    digest.open("refund", "w1");
    digest.settle("w1", "unverified", "");
    expect(renderDigestSection(digest.read())).toContain("refund: carried out, but not confirmed");
  });

  test("PENDING entries come first and survive the cap", () => {
    const digest = createDigestStore();
    for (let i = 0; i < 20; i += 1) {
      digest.open(`settled_tool_${i}`, `s${i}`);
      digest.settle(`s${i}`, "done", "y".repeat(300));
    }
    digest.open("still_running", "p1");
    const text = renderDigestSection(digest.read());
    expect(text.length).toBeLessThanOrEqual(MAX_STATE_DIGEST_CHARS);
    expect(text).toContain("still_running: IN PROGRESS");
    expect(text).toContain("do not tell the caller it is finished");
  });

  test("the cap holds even when the pending list alone overruns", () => {
    const digest = createDigestStore();
    for (let i = 0; i < 24; i += 1) digest.open(`t${i}_${"z".repeat(200)}`, `w${i}`);
    expect(renderDigestSection(digest.read()).length).toBeLessThanOrEqual(MAX_STATE_DIGEST_CHARS);
  });
});
