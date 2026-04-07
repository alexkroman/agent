// Copyright 2025 the AAI authors. MIT license.

import { colorize } from "consola/utils";

export { log } from "@clack/prompts";

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
