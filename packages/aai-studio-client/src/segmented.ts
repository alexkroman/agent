// Copyright 2026 the AAI authors. MIT license.
// The studio's segmented control, as the two rules its three instances share.
//
// A class pair rather than a `<Segmented>` component, because the three call
// sites disagree about the ELEMENT and cannot be one widget: the pane switcher
// (top-bar.tsx) is buttons, the log target picker (logs-view.tsx) is buttons
// that can be disabled, and the home hero's "what to build" (home.tsx) is a
// `fieldset` of real radios so arrow keys move between them. What they share is
// the look — and that had been copy-pasted three times, with the active/inactive
// pair spelled out identically in each, so a change to the studio's one repeated
// control was three edits and logs-view had already drifted onto its own size.
//
// Sizing is deliberately NOT here: `.seg` (styles.css) is the standard one, and
// logs-view passes its own because that picker sits inside a pane header.

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
