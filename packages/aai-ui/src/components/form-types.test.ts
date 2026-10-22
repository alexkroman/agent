// Copyright 2026 the AAI authors. MIT license.

/**
 * `isFileValue` — what a page reads a `<FileField>`'s entry back with instead
 * of casting it. The absent case is the ordinary one (a field with nothing
 * chosen contributes no key), and a near miss must not narrow: a page that
 * trusts the guard reads `name` and `content` straight off the value.
 */

import { describe, expect, test } from "vitest";
import { isFileValue } from "./form-types.ts";

const described = { name: "draft.txt", size: 12, type: "text/plain", lastModified: 1 };

describe("isFileValue", () => {
  test("a described file is one, with or without its content", () => {
    expect(isFileValue(described)).toBe(true);
    expect(isFileValue({ ...described, content: "hello" })).toBe(true);
    expect(isFileValue({ ...described, type: "" })).toBe(true);
  });

  test("nothing chosen is not one", () => {
    expect(isFileValue(undefined)).toBe(false);
    expect(isFileValue(null)).toBe(false);
    expect(isFileValue("draft.txt")).toBe(false);
  });

  test("a near miss is not one", () => {
    const { size: _size, ...withoutSize } = described;
    expect(isFileValue(withoutSize)).toBe(false);
    expect(isFileValue({ ...described, size: "12" })).toBe(false);
    expect(isFileValue({ ...described, content: 42 })).toBe(false);
  });
});
