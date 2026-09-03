// Copyright 2025 the AAI authors. MIT license.

/**
 * Shared tints used by the default components (AssemblyAI design system,
 * "website refresh": warm neutrals over the cream/white surfaces).
 *
 * These sit on top of the {@link ClientTheme} colors, which own the opaque
 * palette. The neutral text steps are **derived from the theme** rather than
 * hardcoded: `ClientTheme` documents `bg`/`surface`/`text` as free-form
 * colors, so a client is free to hand the components a dark ground — and a
 * fixed warm-grey scale tuned for cream leaves the AGENT/TOOL labels, every
 * tool-call args preview, the chevron and both URL chips below WCAG AA while
 * the prose and bubbles around them follow the theme correctly. Measured on a
 * plausible dark theme before this was derived: 14 text nodes under 4.5:1
 * (the faint step at 3.2–3.5:1, the muted step at 2.5:1), against zero on the
 * default light theme.
 *
 * `ERROR_COLOR` and `THINKING_COLOR` stay fixed: they are *semantic* colors
 * whose hue carries the meaning, so they cannot be re-derived from a theme
 * that knows nothing about severity.
 */

/**
 * Blend `text` into `surface` by `pct`, giving a neutral step that stays on
 * the theme's own ink/ground axis. On a light theme this walks *down* from
 * the surface toward the ink; on a dark one it walks *up* from the ground
 * toward the light ink — the same call reads correctly either way, which is
 * the whole reason to derive rather than hardcode.
 */
export function inkTint(text: string, surface: string, pct: number): string {
  return mixInto(text, surface, pct);
}

/**
 * Muted text — subtitles, secondary labels, thinking dots (fg-muted).
 * 75% lands within a couple of RGB steps of the design system's `#57534B`
 * on the default theme.
 */
export const INK_MUTED_PCT = 75;
/**
 * Faint text — live transcripts, state indicator, start-screen subtitle.
 * 65% reproduces the design system's `#6F6A60` on the default theme.
 */
export const INK_FAINT_PCT = 65;
/** Subtle surface tint — inline code, tool-call chips, message bubbles. */
export const INK_SURFACE_PCT = 3;

/** Error red tuned for warm light surfaces. */
export const ERROR_COLOR = "#B3261E";
/** Amber used by the "thinking" state indicator. */
export const THINKING_COLOR = "#B98900";

/**
 * Derive the user-bubble fill/edge from the theme primary (the mock's
 * indigo-50 background with an indigo-100 border), so custom themes keep a
 * coherent tinted bubble instead of a hardcoded indigo.
 */
export function primaryTint(primary: string, surface: string, pct: number): string {
  return mixInto(primary, surface, pct);
}

/**
 * The blend itself — `pct` of `color` over `ground`, in sRGB.
 *
 * One definition rather than one per axis: {@link inkTint} and
 * {@link primaryTint} differ in WHICH theme color they walk from, which is what
 * their names carry, and not in how the walk is spelled. Two copies of the
 * `color-mix()` string are two places a change of color space has to land.
 */
function mixInto(color: string, ground: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, ${ground})`;
}
