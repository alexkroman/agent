// Copyright 2025 the AAI authors. MIT license.

/**
 * Dark theme palette. Raw hex values are exported as `COLORS` for use in
 * both chalk (terminal) and Ink (React) contexts.
 * @module
 */

import chalk from "chalk";

// chalk's bundled supports-color bails when !streamIsTTY before checking
// COLORTERM/TERM. Running via tsx or npm scripts can break TTY detection,
// so we fall back to env vars when chalk detects level 0.
if (chalk.level === 0 && !process.env.NO_COLOR) {
  const ct = process.env.COLORTERM;
  if (ct === "truecolor" || ct === "24bit") {
    chalk.level = 3;
  } else if (ct || /-256(color)?$/i.test(process.env.TERM ?? "")) {
    chalk.level = 2;
  } else if (process.env.TERM_PROGRAM) {
    chalk.level = 1;
  }
}

/** Raw hex color constants shared by chalk and Ink. */
export const COLORS = {
  primary: "#fab283",
  interactive: "#56b6c2",
  error: "#e06c75",
  warning: "#f5a742",
  success: "#7fd88f",
  accent: "#9d7cd8",
  muted: "#808080",
} as const;

/** Primary brand color — warm peach. */
export function primary(s: string): string {
  return chalk.hex(COLORS.primary)(s);
}

/** Interactive/info color — cyan. */
export function interactive(s: string): string {
  return chalk.hex(COLORS.interactive)(s);
}

/** Error color — soft coral. */
export function error(s: string): string {
  return chalk.hex(COLORS.error)(s);
}

/** Warning color — orange. */
export function warning(s: string): string {
  return chalk.hex(COLORS.warning)(s);
}

/** Success color — green. */
export function success(s: string): string {
  return chalk.hex(COLORS.success)(s);
}

/** Accent color — purple. */
export function accent(s: string): string {
  return chalk.hex(COLORS.accent)(s);
}

/** Muted text color — gray. */
export function muted(s: string): string {
  return chalk.hex(COLORS.muted)(s);
}
