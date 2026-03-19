// Copyright 2025 the AAI authors. MIT license.
import chalk from "chalk";
import { error as errorColor, interactive, primary, warning } from "./_colors.ts";

function fmt(action: string, color: (s: string) => string, msg: string): string {
  return `${color(chalk.bold(action))} ${msg}`;
}

/**
 * Prints a primary step message with a right-aligned magenta action label.
 *
 * @param action Short action verb (e.g. `"Bundle"`, `"Deploy"`).
 * @param msg Descriptive message printed after the action label.
 */
export function step(action: string, msg: string): void {
  console.log(fmt(action, primary, msg));
}

/**
 * Prints an informational step message with a right-aligned blue action label.
 *
 * @param action Short action noun (e.g. `"App"`, `"Info"`).
 * @param msg Descriptive message printed after the action label.
 */
export function stepInfo(action: string, msg: string): void {
  console.log(fmt(action, interactive, msg));
}

/**
 * Prints a dimmed informational line, indented to align with step message text.
 *
 * @param msg The message to print.
 */
export function info(msg: string): void {
  console.log(chalk.dim(msg));
}

/** Detail line without dimming. */
export function detail(msg: string): void {
  console.log(msg);
}

/**
 * Prints a yellow warning message to stderr.
 *
 * @param msg The warning message.
 */
export function warn(msg: string): void {
  console.error(fmt("warning", warning, msg));
}

/**
 * Prints a red error message to stderr.
 *
 * @param msg The error message.
 */
export function error(msg: string): void {
  console.error(`${errorColor(chalk.bold("error"))}: ${msg}`);
}
