// Copyright 2026 the AAI authors. MIT license.
// The segmented control's shared class rules: one divider BETWEEN neighbours
// (never before the first item), and one active/inactive pair.

import { describe, expect, test } from "vitest";
import { SEG_GROUP, segItemClass } from "./segmented.ts";

const classes = (s: string) => s.split(/\s+/).filter(Boolean);

describe("SEG_GROUP", () => {
  test("is a clipping flex row with a border", () => {
    expect(classes(SEG_GROUP)).toEqual(
      expect.arrayContaining(["flex", "overflow-hidden", "border", "border-line"]),
    );
  });
});

describe("segItemClass", () => {
  test("the first item draws no divider", () => {
    expect(classes(segItemClass(false, 0))).not.toContain("border-l");
    expect(classes(segItemClass(true, 0))).not.toContain("border-l");
  });

  test.each([1, 2, 5])("item %i draws the divider on its left", (index) => {
    expect(classes(segItemClass(false, index))).toEqual(
      expect.arrayContaining(["border-l", "border-line"]),
    );
  });

  test("active and inactive are disjoint looks", () => {
    const active = classes(segItemClass(true, 1));
    const inactive = classes(segItemClass(false, 1));
    expect(active).toEqual(expect.arrayContaining(["bg-fg", "text-cream"]));
    expect(active).not.toContain("bg-panel");
    expect(inactive).toEqual(expect.arrayContaining(["bg-panel", "text-muted"]));
    expect(inactive).not.toContain("bg-fg");
  });

  test("only an inactive item carries the hover affordance", () => {
    expect(segItemClass(false, 0)).toContain("hover:text-fg");
    expect(segItemClass(true, 0)).not.toContain("hover:");
  });
});
