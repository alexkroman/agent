// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  classifyBargeInPhrase,
  DEFAULT_ACKNOWLEDGEMENT_PHRASES,
  DEFAULT_INTERRUPTION_PHRASES,
  normalizeBargeInText,
} from "./barge-in-phrases.ts";

const LISTS = {
  acknowledgement: DEFAULT_ACKNOWLEDGEMENT_PHRASES,
  interruption: DEFAULT_INTERRUPTION_PHRASES,
};

const classify = (text: string) => classifyBargeInPhrase(text, LISTS);

describe("normalizeBargeInText", () => {
  test('apostrophes are dropped so an ASR\'s "I\'m" reaches the list\'s "im"', () => {
    expect(normalizeBargeInText("I'm listening")).toBe("im listening");
    expect(normalizeBargeInText("I’m listening")).toBe("im listening");
  });

  test('hyphens are spaces, so "uh-huh" and "uh huh" are one phrase', () => {
    expect(normalizeBargeInText("Uh-huh")).toBe(normalizeBargeInText("uh huh"));
  });

  test("punctuation the ASR chose does not decide whether the agent yields", () => {
    expect(normalizeBargeInText("  Stop!! ")).toBe("stop");
  });
});

describe("acknowledgement phrases never interrupt", () => {
  test.each(["okay", "Okay.", "mm-hmm", "uh huh", "I'm listening", "yeah sure", "GOT IT"])(
    "%j is a backchannel",
    (text) => {
      expect(classify(text)).toBe("acknowledge");
    },
  );

  test("the list matches the WHOLE utterance, so a real turn opening with one is not swallowed", () => {
    expect(classify("okay so I need to change my order")).toBe("none");
    expect(classify("yeah I wanted the blue one")).toBe("none");
  });
});

describe("interruption phrases always interrupt", () => {
  test.each(["stop", "Stop talking", "wait wait wait", "hold on", "nevermind", "shut up"])(
    "%j takes the floor",
    (text) => {
      expect(classify(text)).toBe("interrupt");
    },
  );

  test("it matches anywhere, as whole words", () => {
    expect(classify("yeah actually no")).toBe("interrupt");
    // "no" as a whole word, not as the prefix of another word.
    expect(classify("november please")).toBe("none");
    expect(classify("notable")).toBe("none");
  });
});

describe("the yes/no asymmetry is deliberate", () => {
  test('"yes" never interrupts and "no" always does', () => {
    expect(classify("yes")).toBe("acknowledge");
    expect(classify("no")).toBe("interrupt");
  });

  test("it survives the ASR's punctuation and casing", () => {
    expect(classify("Yes.")).toBe("acknowledge");
    expect(classify("No!")).toBe("interrupt");
  });

  test("the two lists really do disagree about the pair, which is the property to keep", () => {
    expect(DEFAULT_ACKNOWLEDGEMENT_PHRASES).toContain("yes");
    expect(DEFAULT_INTERRUPTION_PHRASES).toContain("no");
    expect(DEFAULT_ACKNOWLEDGEMENT_PHRASES).not.toContain("no");
    expect(DEFAULT_INTERRUPTION_PHRASES).not.toContain("yes");
  });
});

describe("precedence and the off switch", () => {
  test('interruption is checked first, so "okay stop" interrupts', () => {
    expect(classify("okay stop")).toBe("interrupt");
  });

  test('an empty pair of lists always answers "none" — the pre-feature behaviour', () => {
    expect(classifyBargeInPhrase("stop", { acknowledgement: [], interruption: [] })).toBe("none");
    expect(classifyBargeInPhrase("okay", { acknowledgement: [], interruption: [] })).toBe("none");
  });

  test("either list can be switched off on its own", () => {
    expect(
      classifyBargeInPhrase("okay", {
        acknowledgement: [],
        interruption: DEFAULT_INTERRUPTION_PHRASES,
      }),
    ).toBe("none");
    expect(
      classifyBargeInPhrase("stop", {
        acknowledgement: DEFAULT_ACKNOWLEDGEMENT_PHRASES,
        interruption: [],
      }),
    ).toBe("none");
  });

  test("an author's own lists replace the shipped ones wholesale", () => {
    const lists = { acknowledgement: ["si"], interruption: ["basta"] };
    expect(classifyBargeInPhrase("si", lists)).toBe("acknowledge");
    expect(classifyBargeInPhrase("basta ya", lists)).toBe("interrupt");
    expect(classifyBargeInPhrase("stop", lists)).toBe("none");
  });

  test("an utterance with no words is nobody's business", () => {
    expect(classify("")).toBe("none");
    expect(classify("...")).toBe("none");
  });

  test("a multi-word phrase matches as a contiguous run, not as scattered words", () => {
    const lists = { acknowledgement: [], interruption: ["hold on"] };
    expect(classifyBargeInPhrase("hold on a second", lists)).toBe("interrupt");
    expect(classifyBargeInPhrase("hold the line on that", lists)).toBe("none");
  });
});
