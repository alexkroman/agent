// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  errorDetail,
  errorMessage,
  isTextAssetPath,
  normalizeSpeechText,
  toArgsRecord,
} from "./utils.ts";

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

describe("errorMessage", () => {
  test("extracts message from Error instance", () => {
    expect(errorMessage(new Error("something broke"))).toBe("something broke");
  });

  test("converts string to string", () => {
    expect(errorMessage("plain string")).toBe("plain string");
  });

  test("converts number to string", () => {
    expect(errorMessage(42)).toBe("42");
  });

  test("converts null to string", () => {
    expect(errorMessage(null)).toBe("null");
  });

  test("converts undefined to string", () => {
    expect(errorMessage(undefined)).toBe("undefined");
  });
});

describe("errorDetail", () => {
  test("returns stack trace when available", () => {
    const err = new Error("something broke");
    const result = errorDetail(err);
    expect(result).toBe(err.stack);
    expect(result).toContain("something broke");
  });

  test("returns message when stack is undefined", () => {
    const err = new Error("no stack");
    Object.defineProperty(err, "stack", { value: undefined });
    expect(errorDetail(err)).toBe("no stack");
  });

  test("converts string to string", () => {
    expect(errorDetail("plain string")).toBe("plain string");
  });

  test("converts null to string", () => {
    expect(errorDetail(null)).toBe("null");
  });

  test("converts undefined to string", () => {
    expect(errorDetail(undefined)).toBe("undefined");
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
  // `text.length` (pipeline-heard.ts), and that index decides what history
  // records as heard and where a resume picks up. A substitution that changed
  // length would silently shift both.
  test("is length-preserving, which the heard cursor depends on", () => {
    for (const s of ["You’re “done”", "‘’‚‛ʼ′“”„″", "no typography here"]) {
      expect(normalizeSpeechText(s)).toHaveLength(s.length);
    }
  });

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
