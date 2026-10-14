// Copyright 2026 the AAI authors. MIT license.
// The studio's segmented control (the pane switcher in top-bar.tsx), as the
// group and item class rules. Sizing is `.seg` in styles.css.

import clsx from "clsx";

/** The group box. Every instance is a flex row that clips its children's corners. */
export const SEG_GROUP = "flex overflow-hidden rounded-sm border border-line";

/**
 * One item's state and its seam.
 *
 * `index` draws the divider on every item but the first, which is what puts a
 * single line BETWEEN neighbours rather than a border around each.
 */
export function segItemClass(active: boolean, index: number): string {
  return clsx(
    index > 0 && "border-l border-line",
    active ? "bg-fg text-cream" : "bg-panel text-muted hover:text-fg",
  );
}
