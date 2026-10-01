// Copyright 2026 the AAI authors. MIT license.
// The record's MEMORY bound, and the one claim that makes it safe: retention
// can never change what a request sends. See _history-retention.ts.

import { ASSEMBLYAI_GATEWAY_MODELS } from "@alexkroman1/aai/host-internal";
import type { ModelMessage } from "ai";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  contextTokenBudget,
  estimateMessageTokens,
  LARGEST_CONTEXT_TOKEN_BUDGET,
  trimToTokenBudget,
} from "./context-budget.ts";
import {
  createRetainedView,
  estimateConversationTokens,
  evictBeyondRetention,
  HISTORY_RETAIN_FACTOR,
  HISTORY_RETAIN_TOKENS,
} from "./retention.ts";

/** Messages whose estimate is their own number, so a case reads as arithmetic. */
const weigh = (n: number): number => n;
const notTool = (m: ModelMessage): boolean => m.role !== "tool";

const call = (id: string, pad: number): ModelMessage => ({
  role: "assistant",
  content: [
    { type: "tool-call", toolCallId: id, toolName: "lookup", input: { pad: "x".repeat(pad) } },
  ],
});
const result = (id: string, pad: number): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "lookup",
      output: { type: "text", value: "y".repeat(pad) },
    },
  ],
});

describe("evictBeyondRetention", () => {
  test("drops the oldest while the rest still reaches the bound, and no further", () => {
    const arr = [5, 5, 5, 5, 5];
    expect(evictBeyondRetention(arr, 12, weigh)).toEqual([5, 5]);
    // 15 left: one more would leave 10, below the bound.
    expect(arr).toEqual([5, 5, 5]);
  });

  test("a record under the bound is untouched", () => {
    const arr = [1, 2, 3];
    expect(evictBeyondRetention(arr, 6, weigh)).toEqual([]);
    expect(arr).toEqual([1, 2, 3]);
  });

  test("keeps at least one message, however large", () => {
    const arr = [100, 100];
    evictBeyondRetention(arr, 1, weigh);
    expect(arr).toEqual([100]);
  });

  test("never cuts at a message that cannot lead, and measures AFTER skipping it", () => {
    // [call 1][result 1][text 1]...: a naive cut at index 1 would leave a
    // result first. The pair goes whole, and only if what stays still reaches
    // the bound with the result gone too.
    const arr: ModelMessage[] = [call("a", 0), result("a", 0), call("b", 0), result("b", 0)];
    const one = estimateMessageTokens(arr[0] as ModelMessage);
    const pair = one + estimateMessageTokens(arr[1] as ModelMessage);
    const evicted = evictBeyondRetention(arr, pair, estimateMessageTokens, notTool);
    expect(evicted.map((m) => m.role)).toEqual(["assistant", "tool"]);
    expect(arr.map((m) => m.role)).toEqual(["assistant", "tool"]);
    // A bound one token above what the second pair alone costs: evicting the
    // first pair would go below it, so nothing moves.
    const again: ModelMessage[] = [call("a", 0), result("a", 0), call("b", 0), result("b", 0)];
    expect(evictBeyondRetention(again, pair + 1, estimateMessageTokens, notTool)).toEqual([]);
  });

  test("the text-view estimate is memoized on the message object", () => {
    const m = { role: "user" as const, content: "hello there" };
    expect(estimateConversationTokens(m)).toBe(estimateConversationTokens(m));
    expect(estimateConversationTokens(m)).toBeGreaterThan(0);
  });
});

describe("createRetainedView", () => {
  test("a running total evicts exactly what a full re-sum would, push by push", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 3 }), {
          maxLength: 30,
        }),
        fc.integer({ min: 1, max: 60 }),
        (pushes, retain) => {
          const viewed: number[] = [];
          const reference: number[] = [];
          const view = createRetainedView(() => viewed, retain, weigh);
          for (const added of pushes) {
            viewed.push(...added);
            reference.push(...added);
            expect(view.push(added)).toEqual(evictBeyondRetention(reference, retain, weigh));
            expect(viewed).toEqual(reference);
          }
        },
      ),
    );
  });

  test("recount re-measures after a write that is not an append", () => {
    const arr = [5, 5, 5];
    const view = createRetainedView(() => arr, 12, weigh);
    arr.length = 0;
    view.recount();
    arr.push(5, 5);
    expect(view.push([5, 5])).toEqual([]);
  });
});

describe("HISTORY_RETAIN_TOKENS", () => {
  test("is a multiple of the largest request budget any model can be given", () => {
    expect(HISTORY_RETAIN_TOKENS).toBe(HISTORY_RETAIN_FACTOR * LARGEST_CONTEXT_TOKEN_BUDGET);
    expect(HISTORY_RETAIN_FACTOR).toBeGreaterThanOrEqual(1);
  });

  test("no model's budget — known or not — exceeds what the record retains", () => {
    // The premise of "retention never reaches into a request": every budget is
    // at most LARGEST_CONTEXT_TOKEN_BUDGET, and the record keeps at least that.
    for (const id of Object.keys(ASSEMBLYAI_GATEWAY_MODELS)) {
      expect.soft(contextTokenBudget(id), id).toBeLessThanOrEqual(LARGEST_CONTEXT_TOKEN_BUDGET);
    }
    expect(contextTokenBudget("some-self-hosted-model")).toBeLessThanOrEqual(
      LARGEST_CONTEXT_TOKEN_BUDGET,
    );
  });
});

/** One turn's shape: its text sizes, and how many tool pairs it carries. */
type TurnShape = { readonly text: number; readonly tools: number; readonly pad: number };

const turnArb: fc.Arbitrary<TurnShape> = fc.record({
  text: fc.integer({ min: 0, max: 400 }),
  tools: fc.integer({ min: 0, max: 2 }),
  pad: fc.integer({ min: 0, max: 600 }),
});

function build(shapes: readonly TurnShape[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  shapes.forEach((t, i) => {
    out.push({ role: "user", content: `q${i} ${"w ".repeat(t.text)}` });
    for (let k = 0; k < t.tools; k++)
      out.push(call(`c${i}_${k}`, t.pad), result(`c${i}_${k}`, t.pad));
    out.push({ role: "assistant", content: `a${i} ${"v ".repeat(t.text)}` });
  });
  return out;
}

describe("retention never changes a request", () => {
  test("a retained record sends exactly what the full record would, at any budget up to the bound", () => {
    // The whole safety argument as a property: the request budget keeps a
    // SUFFIX no larger than its limit, so any retained suffix at least the
    // bound contains it. Generated sizes, pairs, limits and measured overheads.
    let trimmedRequests = 0;
    let evictedRecords = 0;
    fc.assert(
      fc.property(
        fc.array(turnArb, { minLength: 1, maxLength: 40 }),
        fc.integer({ min: 50, max: 4000 }),
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 200 }),
        (shapes, retain, fraction, overhead) => {
          const full = build(shapes);
          const retained = [...full];
          if (evictBeyondRetention(retained, retain, estimateMessageTokens, notTool).length > 0) {
            evictedRecords++;
          }
          const limit = Math.max(1, Math.floor(retain * fraction));
          const fromFull = trimToTokenBudget(full, limit, overhead);
          if (fromFull.length < full.length) trimmedRequests++;
          expect(trimToTokenBudget(retained, limit, overhead)).toEqual(fromFull);
        },
      ),
      { numRuns: 300 },
    );
    // Both states have to be reached, or the equality is vacuous.
    expect(evictedRecords, "no record was ever evicted").toBeGreaterThan(30);
    expect(trimmedRequests, "no request was ever trimmed").toBeGreaterThan(30);
  });
});
