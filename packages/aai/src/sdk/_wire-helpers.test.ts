// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  capToolResult,
  isTextAssetPath,
  normalizeSpeechText,
  toArgsRecord,
} from "./_wire-helpers.ts";
import { MAX_TOOL_RESULT_CHARS, TOOL_RESULT_TRUNCATION_MARKER } from "./constants.ts";

describe("toArgsRecord", () => {
  test("passes a plain object through unchanged", () => {
    const args = { city: "Paris", n: 1 };
    expect(toArgsRecord(args)).toBe(args);
  });

  test("coerces non-record inputs to an empty record", () => {
    // The raw-string case is what an unrepairable invalid tool call carries.
    expect(toArgsRecord('{"broken json')).toEqual({});
    expect(toArgsRecord(undefined)).toEqual({});
    expect(toArgsRecord(null)).toEqual({});
    expect(toArgsRecord([1, 2])).toEqual({});
    expect(toArgsRecord(42)).toEqual({});
  });
});
describe("isTextAssetPath", () => {
  test.each(["index.html", "assets/app.js", "styles.css", "data.json", "icon.svg", "app.js.map"])(
    "treats %s as text",
    (p) => {
      expect(isTextAssetPath(p)).toBe(true);
    },
  );

  test.each(["logo.png", "font.woff2", "img.jpg", "clip.mp3", "module.wasm", "noext"])(
    "treats %s as binary",
    (p) => {
      expect(isTextAssetPath(p)).toBe(false);
    },
  );

  test("is case-insensitive on the extension", () => {
    expect(isTextAssetPath("INDEX.HTML")).toBe(true);
    expect(isTextAssetPath("LOGO.PNG")).toBe(false);
  });
});

describe("normalizeSpeechText", () => {
  test("folds the apostrophe LLMs actually emit", () => {
    // Model output is typeset prose: `You’re`, `I’ll`, `don’t` all carry
    // U+2019, which is a different codepoint from the `'` that pronunciation
    // lexicons are keyed on.
    expect(normalizeSpeechText("You’re verified. I’ll check, don’t worry.")).toBe(
      "You're verified. I'll check, don't worry.",
    );
  });

  test("folds the rest of the quote family", () => {
    expect(normalizeSpeechText("‘a’ “b” „c‟")).toBe('\'a\' "b" "c"');
    expect(normalizeSpeechText("5′ by 6″")).toBe("5' by 6\"");
    expect(normalizeSpeechText("Hawaiʼi")).toBe("Hawai'i");
  });

  // THE invariant. The heard cursor indexes a reply's TTS text by
  // `text.length` (aai-runtime/src/transports/pipeline/heard/tracker.ts), and that index decides what history
  // records as heard and where a resume picks up. A substitution that changed
  // length would silently shift both.
  test.each(["You’re “done”", "‘’‚‛ʼ′“”„″", "no typography here"])(
    "is length-preserving, which the heard cursor depends on: %j",
    (s) => {
      expect(normalizeSpeechText(s)).toHaveLength(s.length);
    },
  );

  // Prosody, not typography: TTS engines already render these as pauses, and
  // folding them would also break the length invariant above.
  test("leaves prosodic punctuation alone", () => {
    const s = "Wait — hold on … ready?";
    expect(normalizeSpeechText(s)).toBe(s);
  });

  test("returns the same reference when there is nothing to replace", () => {
    const s = "Found your account. Two orders.";
    expect(normalizeSpeechText(s)).toBe(s);
  });

  // The regex is module-scoped with /g, so a stale lastIndex would make every
  // other call skip the start of its input.
  test("repeated calls do not leak regex state", () => {
    const s = "It’s fine";
    expect(normalizeSpeechText(s)).toBe("It's fine");
    expect(normalizeSpeechText(s)).toBe("It's fine");
    expect(normalizeSpeechText(s)).toBe("It's fine");
  });
});

describe("capToolResult", () => {
  test("returns a result at the cap unchanged", () => {
    const result = "x".repeat(MAX_TOOL_RESULT_CHARS);
    expect(capToolResult(result)).toBe(result);
  });

  test("marks the cut, and the marker's length comes out of the budget", () => {
    const capped = capToolResult("x".repeat(MAX_TOOL_RESULT_CHARS + 10));
    expect(capped).toHaveLength(MAX_TOOL_RESULT_CHARS);
    expect(capped.endsWith(TOOL_RESULT_TRUNCATION_MARKER)).toBe(true);
  });
});
