// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { isCommittingTurn } from "./_assemblyai-turn.ts";

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
