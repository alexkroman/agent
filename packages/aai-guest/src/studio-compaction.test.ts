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

/**
 * The assistant half of one build attempt: what the agent SAID, plus the call.
 *
 * The text part is not decoration — `streamText` emits it alongside the
 * tool-call, and it is what survives tier 1. Pruning drops the payloads and
 * leaves the narrative ("attempt 3: fixing the import"), which is the property
 * that makes the cheap tier an acceptable substitute for a summary.
 */
const toolCall = (id: string): ModelMessage => ({
  role: "assistant",
  content: [
    { type: "text", text: `Attempt ${id}: building the workspace to see what breaks.` },
    { type: "tool-call", toolCallId: id, toolName: "build_agent", input: {} },
  ],
});

/** Its result — a tsc dump, which is the bulk this module exists for. */
const toolResult = (id: string): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "build_agent",
      output: { type: "text", value: `${"e".repeat(4000)} ${id}` },
    },
  ],
});

/**
 * A repair loop: `user`, then N × (assistant text+tool-call, tool result).
 *
 * The alternation is the point — an index-based trim lands on a `tool` message
 * roughly half the time, which is what splits a pair.
 */
function buildLoop(attempts: number): ModelMessage[] {
  return [
    msg("user", "Build me a pizza agent"),
    ...Array.from({ length: attempts }, (_, i) => [toolCall(`c${i}`), toolResult(`c${i}`)]).flat(),
  ];
}

/** Ids of the tool results still carrying their payload. */
function toolResultIds(messages: readonly ModelMessage[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-result") ids.push(part.toolCallId);
    }
  }
  return ids;
}

/** Did tier 2 run? The summary is the only message carrying its marker. */
function summaryOf(messages: readonly ModelMessage[]): string | undefined {
  for (const message of messages) {
    if (
      typeof message.content === "string" &&
      message.content.startsWith("[Earlier in this session,")
    ) {
      return message.content;
    }
  }
}

/**
 * Tool-result ids with no matching tool-call earlier in the list — the exact
 * thing a provider answers with a 400. An oracle rather than a shape check:
 * it is true of a correct compaction however the boundaries were computed.
 */
function orphanedToolResults(messages: readonly ModelMessage[]): string[] {
  const called = new Set<string>();
  const orphans: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") called.add(part.toolCallId);
      if (part.type === "tool-result" && !called.has(part.toolCallId))
        orphans.push(part.toolCallId);
    }
  }
  return orphans;
}

/** The mirror-image error: a tool-call nothing ever answers. */
function unansweredToolCalls(messages: readonly ModelMessage[]): string[] {
  const answered = new Set<string>();
  const calls: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-result") answered.add(part.toolCallId);
      if (part.type === "tool-call") calls.push(part.toolCallId);
    }
  }
  return calls.filter((id) => !answered.has(id));
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

  // The test that stood between these two was named "keeps the original
  // request and the recent work, summarizing the middle" and asserted
  // `toEqual(input)` — that NOTHING was summarized. Its comment claimed it
  // covered the shape contract "by shrinking the budget"; no budget was
  // shrunk, `fakeModel` made `generateText` reject, and the whole body was
  // byte-for-byte the failure-path claim two tests below. The success-path
  // shape contract it named is what this test actually asserts.
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

  test("pruning stale tool payloads alone can bring a build loop under budget", async () => {
    // Tier 1 is deterministic and free, so a bulky-but-short conversation must
    // never reach the summarizer. The model here THROWS if it is called at all,
    // which is what makes this an assertion about cost rather than shape.
    let summarizerCalls = 0;
    const summarizer = new MockLanguageModelV3({
      doGenerate: async () => {
        summarizerCalls += 1;
        throw new Error("tier 2 must not run when tier 1 was enough");
      },
    });
    const input = buildLoop(80);
    expect(needsCompaction(input)).toBe(true);

    const out = await compactMessages(summarizer, input);

    expect(summarizerCalls).toBe(0);
    expect(needsCompaction(out)).toBe(false);
    // The request survives, and so do the recent attempts' payloads.
    expect(out[0]).toEqual(input[0]);
    expect(out.at(-1)).toEqual(input.at(-1));
  });

  test("pruning keeps what the agent SAID while dropping the stale payloads", async () => {
    // The narrative is what stops a repair loop from re-trying an approach it
    // already tried, so tier 1 has to be cheap in bytes and not in memory. This
    // is why the assistant messages in `buildLoop` carry text alongside the
    // tool-call: pruning empties a call-only message and drops it entirely.
    const out = await compactMessages(fakeModel, buildLoop(80));
    expect(JSON.stringify(out)).toContain("Attempt c0: building the workspace");

    // Only the recent window keeps its dumps — that IS the error being fixed.
    // Everything older is down to the one line the agent said about it.
    const kept = toolResultIds(out);
    expect(kept).not.toContain("c0");
    expect(kept).toContain("c79");
    expect(kept.length).toBeLessThanOrEqual(DEFAULT_COMPACTION.keepRecent);
  });

  test("pruning never orphans a tool result or leaves a call unanswered", async () => {
    const input = buildLoop(80);
    const out = await compactMessages(fakeModel, input);
    expect(orphanedToolResults(out)).toEqual([]);
    expect(unansweredToolCalls(out)).toEqual([]);
  });

  test("a summarized middle never cuts a tool-call/result pair apart", async () => {
    // The failure this covers: `recent` beginning on a tool message whose
    // tool-call went into the summary. Both providers reject that outright, so
    // the turn dies at the provider with the whole repair loop still to run.
    // The budget is squeezed to a value tier 1 CANNOT reach, because tier 1
    // alone handles an ordinary build loop — without this the test would place
    // no cuts and assert nothing, which `summaryOf` below is the guard against.
    const summarizer = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "tried to build; a type error remains" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    // Every even keepRecent lands the naive cut on a tool message and every odd
    // one does not, so both parities are covered rather than whichever the
    // default happens to be.
    for (const keepRecent of [4, 5, 8, 9]) {
      const input = buildLoop(40);
      const out = await compactMessages(summarizer, input, {
        ...DEFAULT_COMPACTION,
        budgetTokens: 100,
        keepRecent,
      });
      const label = `keepRecent=${keepRecent}`;
      // Tier 2 really ran — otherwise no cuts were placed and the rest of this
      // asserts nothing about the thing it is named for.
      expect.soft(summaryOf(out), label).toContain("tried to build; a type error remains");
      expect.soft(orphanedToolResults(out), label).toEqual([]);
      expect.soft(unansweredToolCalls(out), label).toEqual([]);
      expect.soft(out[0], label).toEqual(input[0]);
    }
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
