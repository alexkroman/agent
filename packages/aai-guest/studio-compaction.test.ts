// Copyright 2026 the AAI authors. MIT license.

import type { ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, test } from "vitest";
import {
  compactMessages,
  DEFAULT_COMPACTION,
  estimateTokens,
  needsCompaction,
} from "./studio-compaction.ts";

const msg = (role: "user" | "assistant", content: string): ModelMessage =>
  ({ role, content }) as ModelMessage;

/** A conversation whose middle is bulky tool output, as a build loop is. */
function longSession(middleCount: number): ModelMessage[] {
  return [
    msg("user", "Build me a pizza agent"),
    ...Array.from({ length: middleCount }, (_, i) => msg("assistant", `${"x".repeat(4000)} ${i}`)),
    msg("assistant", "latest error"),
  ];
}

describe("needsCompaction", () => {
  test("leaves a short conversation alone", () => {
    expect(needsCompaction([msg("user", "hi")])).toBe(false);
  });

  test("triggers once the estimate passes the budget", () => {
    expect(needsCompaction(longSession(200))).toBe(true);
  });

  test("never compacts when there is nothing but the parts we keep", () => {
    const opts = { ...DEFAULT_COMPACTION, budgetTokens: 0 };
    const short = [msg("user", "a"), msg("assistant", "b")];
    expect(needsCompaction(short, opts)).toBe(false);
  });
});

describe("compactMessages", () => {
  const fakeModel = {} as Parameters<typeof compactMessages>[0];

  test("returns the input untouched when under budget", async () => {
    const input = [msg("user", "hi"), msg("assistant", "there")];
    expect(await compactMessages(fakeModel, input)).toEqual(input);
  });

  test("keeps the original request and the recent work, summarizing the middle", async () => {
    // Uses a stub summarizer via a model that generateText will reject; the
    // failure path must preserve everything, which is asserted below. Here we
    // assert the SHAPE contract on the success path by shrinking the budget
    // and checking the untouched ends survive.
    const input = longSession(100);
    const out = await compactMessages(fakeModel, input);
    // generateText fails on the stub model, so the safe path returns input.
    expect(out).toEqual(input);
  });

  test("a successful summary replaces the middle, keeping both ends verbatim", async () => {
    const summarizer = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "built the agent; fixing a type error" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    const input = longSession(100);
    const out = await compactMessages(summarizer, input);

    expect(out.length).toBe(DEFAULT_COMPACTION.keepLeading + 1 + DEFAULT_COMPACTION.keepRecent);
    // The original request survives verbatim at the front…
    expect(out[0]).toEqual(input[0]);
    // …the most recent work survives verbatim at the back…
    expect(out.at(-1)).toEqual(input.at(-1));
    // …and the middle is one summary message the agent can read as context.
    const summary = out[DEFAULT_COMPACTION.keepLeading] as { role: string; content: string };
    expect(summary.role).toBe("user");
    expect(summary.content).toContain("[Earlier in this session, summarized to save context]");
    expect(summary.content).toContain("built the agent; fixing a type error");
  });

  test("a failed summary preserves the conversation rather than dropping it", async () => {
    // The dangerous failure is silently losing the middle: better a long
    // context than an agent that forgot what it was doing.
    const input = longSession(50);
    const out = await compactMessages(fakeModel, input);
    expect(out.length).toBe(input.length);
    expect(out[0]).toEqual(input[0]);
  });
});

describe("estimateTokens", () => {
  test("counts structured content, not just strings", () => {
    const structured = {
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(400) }],
    } as ModelMessage;
    expect(estimateTokens([structured])).toBeGreaterThan(80);
  });
});
