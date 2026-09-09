// Copyright 2026 the AAI authors. MIT license.
/**
 * The prompt union and its one reader.
 *
 * Two properties are load-bearing and nothing else here is: a string resolves to
 * ITSELF (so every agent that never wanted this is byte-identical), and a thunk
 * is asked again on every read (so a prompt that moves actually moves). The
 * places that must call this rather than read the field — `toAgentConfig`, the
 * transports, `createTextAgent`, `withSystemPrompt` — pin their own halves.
 */

import { describe, expect, test } from "vitest";
import { resolveSystemPrompt } from "./system-prompt-option.ts";

describe("resolveSystemPrompt", () => {
  test("a string resolves to itself, by identity", () => {
    // Identity, not equality: the runtime's per-day cache compares the resolved
    // value with `!==`, so a copy would rebuild the assembled prompt every turn.
    const prompt = "Be brief.";
    expect(resolveSystemPrompt(prompt)).toBe(prompt);
  });

  test("a thunk is called on EVERY read, not memoized here", () => {
    let turn = 0;
    const prompt = (): string => `turn ${++turn}`;
    expect(resolveSystemPrompt(prompt)).toBe("turn 1");
    expect(resolveSystemPrompt(prompt)).toBe("turn 2");
  });

  test("an empty prompt survives as itself rather than becoming a default", () => {
    // `""` is a declaration ("no instructions"), and the caller — not this
    // function — is the one that decides what an absent prompt means.
    expect(resolveSystemPrompt("")).toBe("");
    expect(resolveSystemPrompt(() => "")).toBe("");
  });
});
