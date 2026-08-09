// Copyright 2025 the AAI authors. MIT license.

import { styleText } from "node:util";
import * as p from "@clack/prompts";

type Log = typeof p.log;

const noop = () => {
  /* no-op */
};
let silenced = false;

const logHandler: ProxyHandler<Log> = {
  get(target, prop, receiver) {
    return silenced ? noop : Reflect.get(target, prop, receiver);
  },
};

/** Log instance that delegates to clack (human mode) or no-ops (JSON mode). */
export const log: Log = new Proxy(p.log, logHandler);

/** Replace all log methods with no-ops. Call once in JSON mode. */
export function silenceOutput(): void {
  silenced = true;
}

/**
 * Emit a message that must survive JSON mode — human mode gets the normal
 * clack styling, JSON mode gets a plain line on STDERR.
 *
 * `silenceOutput` no-ops every `log` method so that JSON mode's contract
 * ("exactly one result line on stdout") holds. That is right for
 * request/response commands, and wrong for LONG-RUNNING ones: `aai dev`
 * writes its single JSON line at startup and then keeps running, so every
 * later message — a failed rebuild, an unhandled rejection, "the dev server
 * is down; save a file to retry" — was silenced for the rest of the process.
 * And JSON mode is AUTO-DETECTED on a pipe, so that is the normal case:
 * `aai dev > dev.log`, a process supervisor, or a container all hid every
 * build failure, leaving the old agent served with nothing to say why edits
 * had stopped taking effect.
 *
 * stderr keeps the stdout contract intact — a script still parses one JSON
 * line — while a human tailing the log sees what happened.
 */
export function notify(level: "error" | "warn" | "info" | "success", message: string): void {
  if (!silenced) {
    log[level](message);
    return;
  }
  process.stderr.write(`${message}\n`);
}

/** Whether `silenceOutput()` has been called — i.e. we are in JSON mode. */
export function outputSilenced(): boolean {
  return silenced;
}

/**
 * Unwrap a clack prompt result, exiting cleanly if the user cancelled.
 * `message` lets the caller name what was cancelled (e.g. "Setup cancelled").
 */
export function unwrapCancel<T>(result: T | symbol, message = "Cancelled"): T {
  if (p.isCancel(result)) {
    p.cancel(message);
    process.exit(0);
  }
  return result as T;
}

/** Format a URL for display. */
export function fmtUrl(url: string): string {
  return styleText("cyanBright", url);
}

/**
 * Parse and validate a port string. Returns the numeric port or throws.
 *
 * Deliberately zod-free: this module loads on every CLI invocation
 * (including `aai --help`), and keeping zod off that path is the same
 * startup-cost invariant `_utils.ts` documents for its error helpers.
 */
export function parsePort(raw: string): number {
  // `Number("")` is 0, so an empty/whitespace string must be rejected up front.
  const port = raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${raw}. Must be a number between 0 and 65535.`);
  }
  return port;
}
