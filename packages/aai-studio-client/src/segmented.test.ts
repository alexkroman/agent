// Copyright 2026 the AAI authors. MIT license.
// The segmented control's shared class rules: a recessed track, and one
// active/inactive pair.

import { describe, expect, test } from "vitest";
import { SEG_GROUP, segItemClass } from "./segmented.ts";

const classes = (s: string) => s.split(/\s+/).filter(Boolean);

describe("SEG_GROUP", () => {
  test("is a flex row on a recessed track", () => {
    expect(classes(SEG_GROUP)).toEqual(expect.arrayContaining(["flex", "bg-cream"]));
  });
});

describe("segItemClass", () => {
  test("active and inactive are disjoint looks", () => {
    const active = classes(segItemClass(true));
    const inactive = classes(segItemClass(false));
    expect(active).toEqual(expect.arrayContaining(["bg-panel", "text-fg"]));
    expect(active).not.toContain("text-muted");
    expect(inactive).toEqual(expect.arrayContaining(["text-muted"]));
    expect(inactive).not.toContain("bg-panel");
  });

  test("only an inactive item carries the hover affordance", () => {
    expect(segItemClass(false)).toContain("hover:text-fg");
    expect(segItemClass(true)).not.toContain("hover:");
  });
});
