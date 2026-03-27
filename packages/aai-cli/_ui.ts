// Copyright 2025 the AAI authors. MIT license.

import { colorize } from "consola/utils";

/** Primary brand color wrapper (cyan highlight). */
export function primary(s: string): string {
  return colorize("cyanBright", s);
}

/** Interactive/info color wrapper (blue). */
export function interactive(s: string): string {
  return colorize("blueBright", s);
}

/** Colored step message: bold action label + message. */
export function step(action: string, msg: string): string {
  return `${colorize("bold", colorize("cyanBright", action))} ${msg}`;
}

/** Informational step message: bold blue action + message. */
export function stepInfo(action: string, msg: string): string {
  return `${colorize("bold", colorize("blueBright", action))} ${msg}`;
}

/** Dimmed info sub-line (indented). */
export function info(msg: string): string {
  return colorize("dim", `  ${msg}`);
}

/** Detail sub-line (indented). */
export function detail(msg: string): string {
  return `  ${msg}`;
}

/** Warning message. */
export function warn(msg: string): string {
  return `${colorize("yellowBright", "!")} ${msg}`;
}

/** Error message. */
export function errorLine(msg: string): string {
  return `${colorize("redBright", "x")} ${msg}`;
}

/** Parse and validate a port string. Returns the numeric port or throws. */
export function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  if (Number.isNaN(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${raw}. Must be a number between 0 and 65535.`);
  }
  return port;
}

/** Helpers passed to the `run` callback of `runCommand`. */
export type RunHelpers = {
  log: (msg: string) => void;
  setStatus: (msg: string | null) => void;
};

/**
 * Run an async command function, logging each step to stdout.
 * Replaces the Ink `runWithInk` pattern.
 */
export async function runCommand(fn: (helpers: RunHelpers) => Promise<void>): Promise<void> {
  const log = (msg: string) => console.log(msg);
  const setStatus = (msg: string | null) => {
    if (msg) {
      process.stdout.write(`\r${colorize("dim", msg)}`);
    } else {
      process.stdout.write("\r\x1b[K");
    }
  };
  await fn({ log, setStatus });
}
