// Copyright 2026 the AAI authors. MIT license.
// Specs for CHOOSING which of a tool's declared messages a given call gets:
// the argument conditions, the variant draw, and the rule that decides whether
// two `delayed` entries are one rung or two.
//
// A sibling of `tool-messages.test.ts`, which owns the DECLARATION half (the
// shorthands, and what reaches the wire). Everything here is a pure function of
// (declaration, arguments, random); the runtime half is `aai-runtime`'s
// `tool-messages-runner.test.ts`.

import { describe, expect, test } from "vitest";
import { createSeededRandom } from "./random.ts";
import {
  DEFAULT_TOOL_START_PHRASES,
  type ToolCompletionMessage,
  type ToolDelayedMessage,
} from "./tool-messages.ts";
import {
  matchesToolConditions,
  planDelayedLadder,
  selectToolMessage,
} from "./tool-messages-select.ts";

/** Draw the Nth item of whatever list is offered, for a deterministic variant. */
const pick = (index: number) => (): number => index / 100;

describe("conditions on the call's arguments", () => {
  test("`eq` is the default and compares the named argument", () => {
    expect(matchesToolConditions([{ arg: "action", value: "refund" }], { action: "refund" })).toBe(
      true,
    );
    expect(matchesToolConditions([{ arg: "action", value: "refund" }], { action: "lookup" })).toBe(
      false,
    );
  });

  test("every condition must hold, and no conditions always holds", () => {
    const both = [
      { arg: "action", value: "refund" },
      { arg: "amount", op: "gt" as const, value: 100 },
    ];
    expect(matchesToolConditions(both, { action: "refund", amount: 250 })).toBe(true);
    expect(matchesToolConditions(both, { action: "refund", amount: 50 })).toBe(false);
    expect(matchesToolConditions(undefined, { action: "refund" })).toBe(true);
    expect(matchesToolConditions([], {})).toBe(true);
  });

  test("an ordering operator against a non-number does not match, and does not throw", () => {
    // The model chooses these values. A condition it makes nonsense of may cost
    // the call a filler line; it may not cost the call.
    expect(matchesToolConditions([{ arg: "n", op: "gte", value: 5 }], { n: "many" })).toBe(false);
    expect(matchesToolConditions([{ arg: "n", op: "lt", value: 5 }], {})).toBe(false);
    expect(matchesToolConditions([{ arg: "n", op: "lte", value: 5 }], { n: 5 })).toBe(true);
    expect(matchesToolConditions([{ arg: "n", op: "neq", value: 5 }], { n: 6 })).toBe(true);
  });

  test("a conditional line is drawn only for the arguments it names", () => {
    const complete: ToolCompletionMessage[] = [
      { content: "Refund issued.", when: [{ arg: "action", value: "refund" }] },
      { content: "Here's the order.", when: [{ arg: "action", value: "lookup" }] },
    ];
    expect(selectToolMessage(complete, { action: "refund" })?.content).toBe("Refund issued.");
    expect(selectToolMessage(complete, { action: "lookup" })?.content).toBe("Here's the order.");
    // Neither condition holds — a legitimate outcome, not a failure.
    expect(selectToolMessage(complete, { action: "cancel" })).toBeUndefined();
  });
});

describe("variants", () => {
  test("one of the eligible lines is DRAWN, and every one is reachable", () => {
    const start = [{ content: "a" }, { content: "b" }, { content: "c" }];
    expect(selectToolMessage(start, {}, pick(0))?.content).toBe("a");
    expect(selectToolMessage(start, {}, pick(34))?.content).toBe("b");
    expect(selectToolMessage(start, {}, pick(99))?.content).toBe("c");
  });

  test("a real random source spreads across the pool rather than repeating", () => {
    // The reason variants exist at all: an agent whose turn calls three tools
    // must not say the same sentence three times.
    const random = createSeededRandom(7);
    const drawn = new Set(
      Array.from(
        { length: 40 },
        () =>
          selectToolMessage(
            DEFAULT_TOOL_START_PHRASES.map((c) => ({ content: c })),
            {},
            random,
          )?.content,
      ),
    );
    expect(drawn.size).toBe(DEFAULT_TOOL_START_PHRASES.length);
  });

  test("the draw only ever considers the ELIGIBLE lines", () => {
    const start = [
      { content: "refund-only", when: [{ arg: "action", value: "refund" }] },
      { content: "always" },
    ];
    // Even at the top of the range, the ineligible variant cannot be drawn.
    expect(selectToolMessage(start, { action: "lookup" }, pick(99))?.content).toBe("always");
  });
});

describe("the delay ladder: same timing means variants, different timings mean stages", () => {
  const ladder: ToolDelayedMessage[] = [
    { afterMs: 3000, content: "still checking" },
    { afterMs: 3000, content: "bear with me" },
    { afterMs: 8000, content: "almost there" },
  ];

  test("entries sharing a timing collapse to ONE rung", () => {
    const rungs = planDelayedLadder(ladder, {}, pick(0));
    expect(rungs).toEqual([
      { afterMs: 3000, content: "still checking" },
      { afterMs: 8000, content: "almost there" },
    ]);
  });

  test("the rung's own variants are what the draw chooses between", () => {
    // The grouping has to happen BEFORE the draw. Drawing first would make this
    // a coin flip between "a line at 3s" and "a line at 8s" instead of both.
    expect(planDelayedLadder(ladder, {}, pick(99))).toEqual([
      { afterMs: 3000, content: "bear with me" },
      { afterMs: 8000, content: "almost there" },
    ]);
  });

  test("rungs come back ascending however they were declared", () => {
    const declared: ToolDelayedMessage[] = [
      { afterMs: 9000, content: "last" },
      { afterMs: 1000, content: "first" },
      { afterMs: 5000, content: "middle" },
    ];
    expect(planDelayedLadder(declared, {}).map((r) => r.afterMs)).toEqual([1000, 5000, 9000]);
  });

  test("a rung whose conditions fail is dropped, not shifted", () => {
    const conditional: ToolDelayedMessage[] = [
      { afterMs: 3000, content: "refunding", when: [{ arg: "action", value: "refund" }] },
      { afterMs: 8000, content: "almost there" },
    ];
    expect(planDelayedLadder(conditional, { action: "lookup" })).toEqual([
      { afterMs: 8000, content: "almost there" },
    ]);
  });

  test("no declaration is an empty ladder", () => {
    expect(planDelayedLadder(undefined, {})).toEqual([]);
  });
});
