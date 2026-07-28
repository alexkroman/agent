// Copyright 2025 the AAI authors. MIT license.

/**
 * Shared tints used by the default components (AssemblyAI design system,
 * "website refresh": warm neutrals over the cream/white surfaces).
 *
 * These sit on top of the {@link ClientTheme} colors (which own the opaque
 * palette) and are intentionally not themeable: they are the warm-gray text
 * steps and ink alpha layers the refresh uses over any light surface.
 */

/** Soft text — button labels on muted surfaces (warm-700). */
export const TEXT_SOFT = "#3D3A35";
/** Muted text — subtitles, secondary labels, thinking dots (fg-muted). */
export const TEXT_MUTED = "#57534B";
/** Faint text — live transcripts, state indicator, start-screen subtitle (warm-500). */
export const TEXT_FAINT = "#6F6A60";
/** Raised surface tint — secondary button background. */
export const SURFACE_RAISED = "rgba(20,18,12,0.05)";
/** Subtle surface tint — message bubbles, tool-call blocks. */
export const SURFACE_TINT = "rgba(20,18,12,0.03)";
/** Error red tuned for warm light surfaces. */
export const ERROR_COLOR = "#B3261E";

/**
 * Derive the user-bubble fill/edge from the theme primary (the mock's
 * indigo-50 background with an indigo-100 border), so custom themes keep a
 * coherent tinted bubble instead of a hardcoded indigo.
 */
export function primaryTint(primary: string, surface: string, pct: number): string {
  return `color-mix(in srgb, ${primary} ${pct}%, ${surface})`;
}
