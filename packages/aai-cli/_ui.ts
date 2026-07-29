// Copyright 2025 the AAI authors. MIT license.

import * as p from "@clack/prompts";
import pc from "picocolors";

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

/** Unwrap a clack prompt result, exiting cleanly if the user cancelled. */
export function unwrapCancel<T>(result: T | symbol): T {
  if (p.isCancel(result)) {
    p.cancel("Setup cancelled");
    process.exit(0);
  }
  return result as T;
}

/** Format a URL for display. */
export function fmtUrl(url: string): string {
  return pc.cyanBright(url);
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
