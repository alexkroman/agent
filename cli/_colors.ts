// Copyright 2025 the AAI authors. MIT license.

/**
 * OC-2 dark theme palette for terminal output.
 * Uses chalk for 24-bit RGB color (truecolor).
 * @module
 */

import chalk from "chalk";

/** Primary brand color — warm peach `#fab283`. */
export function primary(s: string): string {
  return chalk.hex("#fab283")(s);
}

/** Interactive/info color — soft blue `#9dbefe`. */
export function interactive(s: string): string {
  return chalk.hex("#9dbefe")(s);
}

/** Error color — coral red `#fc533a`. */
export function error(s: string): string {
  return chalk.hex("#fc533a")(s);
}

/** Warning color — golden yellow `#fcd53a`. */
export function warning(s: string): string {
  return chalk.hex("#fcd53a")(s);
}
