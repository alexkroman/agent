// Copyright 2025 the AAI authors. MIT license.

import * as p from "@clack/prompts";
import { colorize } from "consola/utils";

/**
 * Unified CLI output using @clack/prompts style (◐ ◇ │).
 *
 * All commands should use these helpers instead of consola directly
 * so the output is visually consistent.
 */
export const log = {
  /** Step starting (spinner-like prefix). */
  step: (msg: string) => p.log.step(msg),
  /** Success (checkmark). */
  success: (msg: string) => p.log.success(msg),
  /** Info (dimmed). */
  info: (msg: string) => p.log.info(msg),
  /** Warning. */
  warn: (msg: string) => p.log.warn(msg),
  /** Error. */
  error: (msg: string) => p.log.error(msg),
  /** Plain message. */
  message: (msg: string) => p.log.message(msg),
};

/** Format a URL for display. */
export function fmtUrl(url: string): string {
  return colorize("cyanBright", url);
}

/** Parse and validate a port string. Returns the numeric port or throws. */
export function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  if (Number.isNaN(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${raw}. Must be a number between 0 and 65535.`);
  }
  return port;
}
