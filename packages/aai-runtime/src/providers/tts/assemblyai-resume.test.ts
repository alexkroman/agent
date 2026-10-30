// Copyright 2026 the AAI authors. MIT license.
// How much of an interrupted flush a pacing recovery re-sends.

import { describe, expect, test } from "vitest";
import { unheardText } from "./assemblyai-resume.ts";

const HEAD = "Your confirmation number is 742. ";
const w = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs });

describe("unheardText", () => {
  test("no audio: all of it", () => {
    expect(unheardText(HEAD, { audioMs: 0, words: [w("Your", 0, 100)] })).toBe(HEAD);
  });

  test("audio but no word timings: none of it", () => {
    expect(unheardText(HEAD, { audioMs: 500, words: [] })).toBe("");
  });

  test("resumes after the last word the received audio covers", () => {
    const words = [w("Your", 0, 150), w("confirmation", 150, 480), w("number", 480, 700)];
    expect(unheardText(HEAD, { audioMs: 500, words })).toBe("number is 742. ");
  });

  test("matching ignores case and punctuation", () => {
    const words = [w("your", 0, 100), w("CONFIRMATION", 100, 200), w("number", 200, 300)];
    const head = "Your confirmation-number, is 742. ";
    // "confirmation-number," is one token; it does not match "CONFIRMATION".
    expect(unheardText(head, { audioMs: 1000, words })).toBe("confirmation-number, is 742. ");
    expect(unheardText(HEAD, { audioMs: 1000, words })).toBe("is 742. ");
  });

  test("a trailing word from the previous flush is skipped, not matched", () => {
    const words = [w("waiting", 2100, 2400), w("Your", 0, 150), w("confirmation", 150, 480)];
    expect(unheardText(HEAD, { audioMs: 500, words })).toBe("number is 742. ");
  });

  test("a word that does not follow ends the match where it stands", () => {
    const words = [w("Your", 0, 150), w("account", 150, 400), w("number", 400, 450)];
    expect(unheardText(HEAD, { audioMs: 500, words })).toBe("confirmation number is 742. ");
  });

  test("every word delivered: nothing left", () => {
    const words = ["Your", "confirmation", "number", "is", "742"].map((t, i) =>
      w(t, i * 100, i * 100 + 90),
    );
    expect(unheardText(HEAD, { audioMs: 1000, words })).toBe("");
  });
});
