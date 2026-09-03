// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { resolveOne, spokenDigits, spokenOrdinal } from "./spoken.ts";
import { isToolFailure } from "./utils.ts";

type Jacket = { id: string; color: string; size: string };

const JACKETS: Jacket[] = [
  { id: "1", color: "blue", size: "medium" },
  { id: "2", color: "blue", size: "large" },
  { id: "3", color: "red", size: "small" },
];

const describeJacket = (jacket: Jacket) => `${jacket.id} (${jacket.color} ${jacket.size})`;
const byOptions = (jacket: Jacket, text: string) =>
  (text.includes(jacket.color) ? 1 : 0) + (text.includes(jacket.size) ? 1 : 0);

describe("spokenDigits", () => {
  test("keeps the digits however STT grouped them", () => {
    expect(spokenDigits("864-219-75")).toBe("86421975");
    expect(spokenDigits("that's 8642 1975, I think")).toBe("86421975");
  });

  test("an utterance with no digits yields none, rather than throwing", () => {
    expect(spokenDigits("the blue one")).toBe("");
  });
});

describe("spokenOrdinal", () => {
  test("reads a position, in either spelling", () => {
    expect(spokenOrdinal("cancel the second one")).toBe(1);
    expect(spokenOrdinal("the 2nd order")).toBe(1);
    expect(spokenOrdinal("the first")).toBe(0);
  });

  test("`last` is -1, so `Array.at` reads it from the other end", () => {
    expect(spokenOrdinal("the last one")).toBe(-1);
  });

  test("names no position when the caller named none", () => {
    expect(spokenOrdinal("cancel my order")).toBeUndefined();
  });

  test("matches whole words — 'firstly' and '21st' are not positions", () => {
    expect(spokenOrdinal("firstly, cancel it")).toBeUndefined();
    expect(spokenOrdinal("the 21st of June")).toBeUndefined();
  });

  test("a position word used as a noun still reads as a position — the documented limit", () => {
    // "the first aid kit" really does contain the word "first", and no boundary
    // rule can say otherwise. The answer is the ORDER in `resolveOne`: a caller
    // narrows by what its domain understands before a position is consulted.
    expect(spokenOrdinal("the first aid kit")).toBe(0);
  });
});

describe("resolveOne", () => {
  test("one candidate is what they meant", () => {
    expect(resolveOne([JACKETS[0] as Jacket], "whatever", { describe: describeJacket })).toEqual(
      JACKETS[0],
    );
  });

  test("a position wins even when nothing else would disambiguate", () => {
    expect(resolveOne(JACKETS, "the second one", { describe: describeJacket })).toEqual(JACKETS[1]);
    expect(resolveOne(JACKETS, "the last one", { describe: describeJacket })).toEqual(JACKETS[2]);
  });

  test("a position past the end fails listing the candidates, rather than picking one", () => {
    const result = resolveOne(JACKETS, "the fifth one", {
      label: "jacket",
      describe: describeJacket,
    });
    expect(isToolFailure(result) && result.error).toContain("are 3 jackets");
    expect(isToolFailure(result) && result.error).toContain("1 (blue medium)");
  });

  test("the scorer picks a single best match", () => {
    expect(
      resolveOne(JACKETS, "the blue medium", { describe: describeJacket, score: byOptions }),
    ).toEqual(JACKETS[0]);
  });

  test("a tie is ambiguous and lists only the tied candidates", () => {
    const result = resolveOne(JACKETS, "the blue one", {
      label: "jacket",
      describe: describeJacket,
      score: byOptions,
    });
    expect(isToolFailure(result)).toBe(true);
    expect(isToolFailure(result) && result.error).toContain("matches 2 jackets");
    expect(isToolFailure(result) && result.error).not.toContain("red");
  });

  test("nothing matching is a failure that lists what there is", () => {
    const result = resolveOne(JACKETS, "the green one", {
      label: "jacket",
      describe: describeJacket,
      score: byOptions,
    });
    expect(isToolFailure(result) && result.error).toContain('No jacket matches "the green one"');
    expect(isToolFailure(result) && result.error).toContain("3 (red small)");
  });

  test("with no scorer, several candidates and no position is ambiguous — never a guess", () => {
    const result = resolveOne(JACKETS, "that one", { label: "jacket", describe: describeJacket });
    expect(isToolFailure(result) && result.error).toContain("That is ambiguous — 3 jackets match");
  });

  test("an empty candidate list says so rather than reporting a failed match", () => {
    const result = resolveOne([], "anything", { label: "jacket", describe: describeJacket });
    expect(isToolFailure(result) && result.error).toBe("There is no jacket to choose from.");
  });

  test("the label defaults to `option`", () => {
    const result = resolveOne([], "anything", { describe: describeJacket });
    expect(isToolFailure(result) && result.error).toBe("There is no option to choose from.");
  });

  test("a FALSY candidate at a named position is still picked", () => {
    // `at` reports "no such position" with `undefined` and nothing else, so the
    // truthiness test this replaced additionally rejected a legitimate falsy
    // candidate: `resolveOne<0 | 5>` could not return `0`, and an empty-string
    // candidate could never be picked at all.
    const describe0 = (n: number) => String(n);
    expect(resolveOne([0, 5], "the first one", { describe: describe0 })).toBe(0);
    expect(resolveOne([5, 0], "the last one", { describe: describe0 })).toBe(0);
    expect(resolveOne(["", "b"], "the first one", { describe: (t) => t })).toBe("");
  });

  test("a position past the end of a falsy list still fails, rather than picking", () => {
    const result = resolveOne([0, 5], "the fifth one", {
      label: "amount",
      describe: (n: number) => String(n),
    });
    expect(isToolFailure(result) && result.error).toContain("are 2 amounts");
  });

  test("the singular reads as one, not as `1 jackets`", () => {
    const result = resolveOne([JACKETS[0] as Jacket], "the fourth one", {
      label: "jacket",
      describe: describeJacket,
    });
    expect(isToolFailure(result) && result.error).toContain("there is 1 jacket:");
  });
});
