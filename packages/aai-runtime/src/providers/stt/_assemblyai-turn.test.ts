// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { isCommittingTurn, wordConfidences } from "./_assemblyai-turn.ts";

const word = (confidence: unknown): { confidence: unknown } => ({ confidence });

describe("wordConfidences", () => {
  test("reports the mean and the minimum", () => {
    const { transcriptConfidence, minWordConfidence } = wordConfidences([
      word(0.9),
      word(0.5),
      word(0.7),
    ]);
    expect(transcriptConfidence).toBeCloseTo(0.7, 10);
    expect(minWordConfidence).toBe(0.5);
  });

  test("a turn with no words reports NOTHING, not zero", () => {
    // The case every live partial hits (`words: []` is in the fixture), and
    // the one a policy must read as "no opinion": a 0 here would discard it.
    expect(wordConfidences([])).toEqual({});
    expect(wordConfidences(undefined)).toEqual({});
  });

  test("skips a word whose confidence is not a finite number", () => {
    expect(wordConfidences([word(0.8), word(null), word("high"), word(Number.NaN)])).toEqual({
      transcriptConfidence: 0.8,
      minWordConfidence: 0.8,
    });
    expect(wordConfidences([word(undefined)])).toEqual({});
  });

  test("the two statistics diverge on the case the policy exists for", () => {
    // One soft digit inside nineteen clean words: the mean stays well above
    // any threshold anyone would set and the minimum is on the floor. This is
    // why both are carried rather than one.
    const words = [...Array.from({ length: 19 }, () => word(1)), word(0.1)];
    const { transcriptConfidence, minWordConfidence } = wordConfidences(words);
    expect(transcriptConfidence).toBeCloseTo(0.955, 3);
    expect(minWordConfidence).toBe(0.1);
  });
});

describe("isCommittingTurn", () => {
  test("without formatting, end_of_turn IS the commit", () => {
    expect(isCommittingTurn({ end_of_turn: true, turn_is_formatted: false }, false)).toBe(true);
    expect(isCommittingTurn({ end_of_turn: false, turn_is_formatted: true }, false)).toBe(false);
  });

  test("awaiting formatting, the UNFORMATTED final is not a commit", () => {
    // `format_turns: true` makes the service send two `end_of_turn` messages
    // for one turn. Committing on the first would answer the same sentence
    // twice — the second time on a history containing the agent's own reply.
    expect(isCommittingTurn({ end_of_turn: true, turn_is_formatted: false }, true)).toBe(false);
    expect(isCommittingTurn({ end_of_turn: true, turn_is_formatted: true }, true)).toBe(true);
  });

  test("a missing turn_is_formatted is not a commit while awaiting one", () => {
    expect(isCommittingTurn({ end_of_turn: true }, true)).toBe(false);
    expect(isCommittingTurn({ end_of_turn: true }, false)).toBe(true);
  });
});
