// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { resolveOne, spokenAlphanumeric, spokenDigits, spokenOrdinal } from "./spoken.ts";
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

describe("spokenAlphanumeric", () => {
  test("keeps letters and digits, upper-cased, however STT spaced or punctuated them", () => {
    expect(spokenAlphanumeric("rs 44-17")).toBe("RS4417");
    expect(spokenAlphanumeric("RS4417")).toBe("RS4417");
    expect(spokenAlphanumeric("#W 586 6402")).toBe("W5866402");
    expect(spokenAlphanumeric("q z seven f, two k")).toBe("QZSEVENFTWOK");
  });

  test("an utterance with nothing alphanumeric yields the empty string", () => {
    expect(spokenAlphanumeric("—, !")).toBe("");
  });

  test("is ASCII-only, so a non-Latin letter is dropped rather than folded", () => {
    expect(spokenAlphanumeric("é9ñ")).toBe("9");
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

describe("resolveOne — the built-in word scorer (`match`)", () => {
  // What four shipped templates had each written by hand, with four different
  // splitting rules: `/\s+/` vs `[^a-z0-9]+` vs a `{3,}` match, a
  // two-character floor vs three, one filler list vs none. The cases below are
  // the places those rules DISAGREED, which is why one built-in is worth
  // having: the same utterance resolved differently in each template.
  type Line = { label: string };
  const FOLIO: Line[] = [
    { label: "Room (3 nights)" },
    { label: "Room service" },
    { label: "Late checkout" },
    { label: "Minibar - still water" },
  ];
  const folio = {
    label: "invoice line",
    describe: (l: Line) => l.label,
    match: (l: Line) => l.label,
  };

  test("every shared word scores, so more words win", () => {
    expect(resolveOne(FOLIO, "the late checkout fee", folio)).toEqual({ label: "Late checkout" });
    expect(resolveOne(FOLIO, "the minibar", folio)).toEqual({ label: "Minibar - still water" });
  });

  test("a word two candidates share is a REFUSAL that asks, not the first row", () => {
    const result = resolveOne(FOLIO, "the room charge", folio);
    expect(isToolFailure(result) && result.error).toContain("matches 2 invoice lines");
    expect(isToolFailure(result) && result.error).toContain("Room service");
  });

  test("punctuation and case are transcription noise on BOTH sides", () => {
    // `Liam O'Connor` tokenizes to liam/connor, so an utterance STT punctuated
    // differently still matches — the case the `/\s+/` splitter got wrong,
    // since `o'connor` only matched an identically-punctuated utterance.
    const people = [{ name: "Liam O'Connor" }, { name: "Mei Tanaka" }];
    const pick = {
      label: "candidate",
      describe: (p: { name: string }) => p.name,
      match: (p: { name: string }) => p.name,
    };
    expect(resolveOne(people, "o'connor please", pick)).toEqual({ name: "Liam O'Connor" });
    expect(resolveOne(people, "Connor", pick)).toEqual({ name: "Liam O'Connor" });
    // The limit, stated rather than implied: a name STT ran together
    // ("OConnor") is ONE token and matches neither half. No built-in here
    // stems or re-splits — a domain that needs it writes `score`.
    expect(isToolFailure(resolveOne(people, "OConnor", pick))).toBe(true);
  });

  test("matching is on whole WORDS, so a fragment does not match inside another word", () => {
    // The `text.includes(word)` splitters' defect, and the one the applicant
    // template's own comment warned about while using a two-character floor:
    // "an" is inside Raman, Tanaka and Kowalski at once.
    const people = [{ name: "Priya Raman" }, { name: "Mei Tanaka" }];
    const pick = {
      label: "candidate",
      describe: (p: { name: string }) => p.name,
      match: (p: { name: string }) => p.name,
    };
    const result = resolveOne(people, "an", pick);
    expect(isToolFailure(result) && result.error).toContain("No candidate matches");
    expect(resolveOne(people, "Raman", pick)).toEqual({ name: "Priya Raman" });
  });

  test("filler words score nothing, so 'the ONE from Dana' is about Dana", () => {
    const mail = [
      { from: "Dana", subject: "Q3 numbers" },
      { from: "Sam", subject: "the one thing" },
    ];
    const pick = {
      label: "email",
      describe: (m: { from: string }) => m.from,
      match: (m: { from: string; subject: string }) => `${m.from} ${m.subject}`,
    };
    expect(resolveOne(mail, "the one from Dana", pick)).toMatchObject({ from: "Dana" });
  });

  test("a plural in the utterance does NOT match a singular field — the documented limit", () => {
    // No stemming, deliberately. A domain where "books" must find `book` wants
    // its own `score` — which is why entertainment-picks-agent keeps one.
    const recs = [{ category: "book" }, { category: "movie" }];
    const pick = {
      label: "recommendation",
      describe: (r: { category: string }) => r.category,
      match: (r: { category: string }) => r.category,
    };
    expect(isToolFailure(resolveOne(recs, "the books", pick))).toBe(true);
    expect(resolveOne(recs, "the book", pick)).toEqual({ category: "book" });
  });

  test("a position still wins over the words", () => {
    expect(resolveOne(FOLIO, "the second one", folio)).toEqual({ label: "Room service" });
  });

  test("`match` and `score` SUM, so a domain scorer breaks a tie the words leave", () => {
    const result = resolveOne(FOLIO, "the room charge", {
      ...folio,
      // "charge" is not a word in either label; this is the domain knowledge.
      score: (line, text) => (text.includes("charge") && line.label.includes("(") ? 1 : 0),
    });
    expect(result).toEqual({ label: "Room (3 nights)" });
  });
});

describe("resolveOne — the built-in code scorer (`code`)", () => {
  type Order = { id: string; status: string };
  const ORDERS: Order[] = [
    { id: "#W5866402", status: "pending" },
    { id: "#W0000001", status: "delivered" },
  ];
  const orders = {
    label: "order",
    describe: (o: Order) => `${o.id} (${o.status})`,
    code: (o: Order) => o.id,
  };

  test("an id read aloud resolves however STT spaced, punctuated or cased it", () => {
    // The `spokenAlphanumeric` id match that sat OUTSIDE resolveOne in
    // retail-orders-agent, and the reading it exists for: a sentence with the
    // id in it, not a bare id.
    expect(resolveOne(ORDERS, "#W5866402", orders)).toMatchObject({ id: "#W5866402" });
    expect(resolveOne(ORDERS, "that's order w 586-6402", orders)).toMatchObject({
      id: "#W5866402",
    });
  });

  test("a code wins over a position in the same sentence", () => {
    // A caller who reads an id has named exactly one thing.
    expect(resolveOne(ORDERS, "the first one, W0000001", orders)).toMatchObject({
      id: "#W0000001",
    });
  });

  test("a code that matches nothing FALLS THROUGH rather than refusing", () => {
    // Whether an id-shaped utterance is a closed question is the caller's
    // knowledge — retail-orders-agent keeps its own "not on this account"
    // branch for exactly that sentence.
    const result = resolveOne(ORDERS, "#W9999999", orders);
    expect(isToolFailure(result) && result.error).toContain("That is ambiguous");
  });

  test("a code too short to be one is ignored, rather than matching everything", () => {
    // Containment on a two-character code matches half of any sentence.
    const seats = [{ seat: "A1" }, { seat: "B2" }];
    const result = resolveOne(seats, "seat a1 please", {
      label: "seat",
      describe: (s: { seat: string }) => s.seat,
      code: (s: { seat: string }) => s.seat,
    });
    expect(isToolFailure(result)).toBe(true);
  });

  test("two candidates carrying one code is a refusal, never a pick", () => {
    const dupes = [{ id: "RS4417" }, { id: "rs-44-17" }];
    const result = resolveOne(dupes, "RS4417", {
      label: "policy",
      describe: (p: { id: string }) => p.id,
      code: (p: { id: string }) => p.id,
    });
    expect(isToolFailure(result) && result.error).toContain("matches 2 policys");
  });
});
