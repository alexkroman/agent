// Copyright 2026 the AAI authors. MIT license.
// The studio's segmented control (the pane tabs in the canvas toolbar), as the
// group and item class rules. Sizing is `.seg` in styles.css.

/**
 * The group: a recessed track the items sit IN, so the selected one reads as
 * raised out of it rather than boxed off by dividers.
 */
export const SEG_GROUP = "flex items-center gap-0.5 rounded-lg bg-cream p-0.5";

/** One item's state: the selected tab is a raised chip, the rest are text on the track. */
export function segItemClass(active: boolean): string {
  return active
    ? "bg-panel text-fg shadow-sm ring-1 ring-line"
    : "bg-transparent text-muted hover:bg-panel/60 hover:text-fg";
}
