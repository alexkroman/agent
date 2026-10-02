// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the one predicate both submit hooks use to decide which form
 * values are files.
 *
 * Node's global `File` is the real class, so no DOM is needed.
 */

import { describe, expect, test } from "vitest";
import { fileFields, filesOf } from "./_workflow-files.ts";

const one = new File(["a"], "one.wav");
const two = new File(["bb"], "two.wav");

describe("filesOf", () => {
  test("a single File is a list of one", () => {
    expect(filesOf(one)).toEqual([one]);
  });

  test("an array of Files is those Files, in order", () => {
    expect(filesOf([one, two])).toEqual([one, two]);
  });

  test("a MIXED array is some other field's value, not files", () => {
    // Turning half of it into ids would corrupt it silently.
    expect(filesOf([one, "two.wav"])).toEqual([]);
  });

  test.each([
    ["an empty array", []],
    ["a string", "one.wav"],
    ["a number", 3],
    ["undefined", undefined],
    ["a plain object", { name: "one.wav" }],
  ])("%s carries no files", (_label, value) => {
    expect(filesOf(value)).toEqual([]);
  });
});

describe("fileFields", () => {
  test("names every property still holding a File, single or listed", () => {
    expect(fileFields({ recording: one, extras: [one, two], topic: "x" })).toEqual([
      "recording",
      "extras",
    ]);
  });

  test("an input with no files left in it names nothing", () => {
    expect(fileFields({ recording: "upl_1", extras: ["upl_2"] })).toEqual([]);
  });

  test("a non-object input has no properties to name", () => {
    expect(fileFields(one)).toEqual([]);
    expect(fileFields("text")).toEqual([]);
    expect(fileFields(null)).toEqual([]);
  });
});
