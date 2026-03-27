// Copyright 2025 the AAI authors. MIT license.

import pc from "picocolors";

/** Primary brand color wrapper. */
export function primary(s: string): string {
  return pc.yellow(s);
}

/** Interactive/info color wrapper. */
export function interactive(s: string): string {
  return pc.cyan(s);
}

/** Colored step message: bold action label + message. */
export function step(action: string, msg: string): string {
  return `${pc.bold(pc.yellow(action))} ${msg}`;
}

/** Informational step message: bold cyan action + message. */
export function stepInfo(action: string, msg: string): string {
  return `${pc.bold(pc.cyan(action))} ${msg}`;
}

/** Dimmed info sub-line (indented). */
export function info(msg: string): string {
  return pc.dim(`  ${msg}`);
}

/** Detail sub-line (indented). */
export function detail(msg: string): string {
  return `  ${msg}`;
}

/** Yellow warning message. */
export function warn(msg: string): string {
  return `${pc.yellow("!")} ${msg}`;
}

/** Red error message. */
export function errorLine(msg: string): string {
  return `${pc.red("x")} ${msg}`;
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
      process.stdout.write(`\r${pc.dim(msg)}`);
    } else {
      process.stdout.write("\r\x1b[K");
    }
  };
  await fn({ log, setStatus });
}
