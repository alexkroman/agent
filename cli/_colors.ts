// Copyright 2025 the AAI authors. MIT license.

/**
 * Dark theme palette based on the opencode color system.
 * Uses chalk for 24-bit RGB color (truecolor).
 * @module
 */

import chalk from "chalk";

/** Primary brand color — warm peach `#fab283`. */
export function primary(s: string): string {
  return chalk.hex("#fab283")(s);
}

/** Interactive/info color — cyan `#56b6c2`. */
export function interactive(s: string): string {
  return chalk.hex("#56b6c2")(s);
}

/** Error color — soft coral `#e06c75`. */
export function error(s: string): string {
  return chalk.hex("#e06c75")(s);
}

/** Warning color — orange `#f5a742`. */
export function warning(s: string): string {
  return chalk.hex("#f5a742")(s);
}

/** Success color — green `#7fd88f`. */
export function success(s: string): string {
  return chalk.hex("#7fd88f")(s);
}

/** Accent color — purple `#9d7cd8`. */
export function accent(s: string): string {
  return chalk.hex("#9d7cd8")(s);
}

/** Muted text color — gray `#808080`. */
export function muted(s: string): string {
  return chalk.hex("#808080")(s);
}
