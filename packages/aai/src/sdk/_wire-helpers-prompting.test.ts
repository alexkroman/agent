// Copyright 2026 the AAI authors. MIT license.
/**
 * What counts as the caller PROMPTING rather than answering.
 *
 * Every positive case is a real caller utterance from a graded tau2-bench
 * retail run (cmp-pipeline-25) in which the agent was waiting on a
 * confirmation and abandoned the write instead. Every negative is the failure
 * mode that would be WORSE than the one being fixed: labelling a real answer
 * as a prompt, which would tell the model to ignore it.
 */

import { describe, expect, it } from "vitest";

import { promptingNote } from "./_wire-helpers.ts";

describe("promptingNote", () => {
  it.each([
    "Hello?",
    "Hello? [pause]",
    "Hello, are you still there?",
    "Hey, are you still there?",
    "Hi, are you still there?",
    "Any update?",
    "Hello? Did you find anything?",
    "Hi. Hello? Did you find anything, or are you still there?",
    "Hello? You still there?",
    "Hey.",
  ])("labels %j as prompting", (text) => {
    expect(promptingNote(text)).toContain("not an answer, and not a refusal");
  });

  it.each([
    // The load-bearing negatives: real answers that happen to open with a
    // greeting. Labelling one of these would be strictly worse than the bug.
    "Hello? Yes, go ahead with the exchange.",
    "Hi, I need to change my address on my account to 101 Highway.",
    "Yeah, first name May, M-E-Y, last name Davis, zip is 80217.",
    "Hello, I want to return the water bottle and the desk lamp.",
    "No, cancel that one instead.",
    "Use the Mastercard ending in 2223.",
  ])("leaves %j alone", (text) => {
    expect(promptingNote(text)).toBeUndefined();
  });

  it("names BOTH readings it rules out", () => {
    // A prompt was being read as a refusal — the measured failure was an agent
    // answering "Understood. No return was submitted. Goodbye." So the note
    // has to deny the refusal reading explicitly, not only the answer one.
    const note = promptingNote("Hello? Are you still there?");
    expect(note).toContain("not an answer");
    expect(note).toContain("not a refusal");
  });

  it("is case- and punctuation-insensitive", () => {
    expect(promptingNote("HELLO?!")).toBeDefined();
    expect(promptingNote("hello")).toBeDefined();
  });

  // A greeting carrying an AFFIRMATION is the answer to a confirmation
  // question, and annotating it says the opposite. `"Hi, yeah."` is not
  // hypothetical: it is the one false positive in the first graded run of this
  // classifier, 1 of 42 annotated turns across 159 committed ones. It matters
  // out of proportion to its rate, because the write this branch is trying to
  // rescue is gated on exactly such a confirmation — so this case fails toward
  // the very outcome the note exists to prevent.
  describe.each([
    "Hi, yeah.",
    "Hello, yes",
    "Hi, no.",
    "Hey, yeah sure",
    "Hello? Yes.",
    "Hi, correct.",
    "Hello, that's right.",
    "Hi, ok.",
  ])("refuses %j — an affirmation ANSWERS", (text) => {
    it("gets no note", () => {
      expect(promptingNote(text)).toBeUndefined();
    });
  });

  it("still annotates a prod that carries no affirmation", () => {
    // The guard must not swallow the positives: these are the two commonest
    // real prods in that run's transcripts (24 of 42 annotated turns).
    expect(promptingNote("Hello?")).toBeDefined();
    expect(promptingNote("Hello? Are you still there?")).toBeDefined();
  });

  it("leaves a BARE affirmation alone, as it always did", () => {
    // Never at risk — it matches no prompt pattern, so it never reached the
    // filler. Pinned so the guard is not credited with work it does not do.
    expect(promptingNote("yeah")).toBeUndefined();
    expect(promptingNote("yes")).toBeUndefined();
  });
});
