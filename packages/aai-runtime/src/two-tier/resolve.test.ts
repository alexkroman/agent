// Copyright 2026 the AAI authors. MIT license.
// Every `twoTier` default, in one place — so a number nobody meant to change
// fails here rather than being discovered from a bill or a benchmark. UNIT tier.

import { DEFAULT_SLOW_TIER_CONTEXT_MESSAGES, DEFAULT_SLOW_TIER_TIMEOUT_MS } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { DEFAULT_SLOW_TIER_MAX_STEPS, resolveTwoTier } from "./resolve.ts";

describe("resolveTwoTier", () => {
  test("undefined in, undefined out — the whole off-switch", () => {
    expect(resolveTwoTier(undefined)).toBeUndefined();
  });

  test("an empty declaration resolves every documented default", () => {
    expect(resolveTwoTier({})).toEqual({
      llm: undefined,
      effort: "high",
      timeoutMs: DEFAULT_SLOW_TIER_TIMEOUT_MS,
      completionGate: true,
      contextMessages: DEFAULT_SLOW_TIER_CONTEXT_MESSAGES,
      maxSteps: DEFAULT_SLOW_TIER_MAX_STEPS,
    });
  });

  test("the completion gate is ON unless the author turns it off", () => {
    expect(resolveTwoTier({})?.completionGate).toBe(true);
    expect(resolveTwoTier({ completionGate: false })?.completionGate).toBe(false);
  });

  test("explicit values win", () => {
    expect(resolveTwoTier({ effort: "low", timeoutMs: 5, contextMessages: 2 })).toMatchObject({
      effort: "low",
      timeoutMs: 5,
      contextMessages: 2,
    });
  });
});
