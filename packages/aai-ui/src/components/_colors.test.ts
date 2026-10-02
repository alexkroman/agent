// Copyright 2026 the AAI authors. MIT license.
/**
 * The derived colours every component tints with.
 *
 * Asserted as the CSS they produce, because that string is the contract: a
 * `color-mix()` is resolved by the browser against whatever theme is live, so
 * a tint is only themable if it stays a mix of the theme's own colours rather
 * than a hex computed once here.
 */

import { describe, expect, test } from "vitest";
import {
  FOCUS_RING,
  focusRingStyle,
  INK_FAINT_PCT,
  INK_MUTED_PCT,
  INK_SURFACE_PCT,
  inkTint,
  primaryTint,
} from "./_colors.ts";

describe("inkTint / primaryTint", () => {
  test("mix the colour into the ground by the given share, in sRGB", () => {
    expect(inkTint("#111", "#fff", INK_MUTED_PCT)).toBe("color-mix(in srgb, #111 75%, #fff)");
    expect(primaryTint("var(--p)", "#fff", 7)).toBe("color-mix(in srgb, var(--p) 7%, #fff)");
  });

  test("the ink steps run muted, then faint, then the near-invisible surface wash", () => {
    // Each step reads as LESS ink than the one before; inverting two of them
    // would make secondary text louder than the label above it.
    expect(INK_MUTED_PCT).toBeGreaterThan(INK_FAINT_PCT);
    expect(INK_FAINT_PCT).toBeGreaterThan(INK_SURFACE_PCT);
    expect(INK_SURFACE_PCT).toBeGreaterThan(0);
  });
});

describe("the focus ring", () => {
  test("shows on keyboard focus only, and takes its colour from the style", () => {
    expect(FOCUS_RING).toContain("outline-none");
    expect(FOCUS_RING).toContain("focus-visible:");
    // The class sets the ring's shape; the colour cannot be a Tailwind class,
    // since it is the theme's primary at runtime.
    expect(focusRingStyle("#2545D3")).toEqual({ outlineColor: "#2545D3" });
  });
});
