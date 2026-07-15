// Copyright 2025 the AAI authors. MIT license.

/**
 * Shared translucent tints used by the default components.
 *
 * These sit on top of the {@link ClientTheme} colors (which own the opaque
 * palette) and are intentionally not themeable: they are alpha layers over
 * whatever background the theme provides.
 */

/** Soft text — button labels on muted surfaces. */
export const TEXT_SOFT = "rgba(255,255,255,0.618)";
/** Muted text — subtitles, secondary labels, thinking dots. */
export const TEXT_MUTED = "rgba(255,255,255,0.422)";
/** Faint text — live transcripts, state indicator, start-screen subtitle. */
export const TEXT_FAINT = "rgba(255,255,255,0.284)";
/** Raised surface tint — secondary button background. */
export const SURFACE_RAISED = "rgba(255,255,255,0.059)";
/** Subtle surface tint — message bubbles, tool-call blocks. */
export const SURFACE_TINT = "rgba(255,255,255,0.031)";
