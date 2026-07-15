// Copyright 2025 the AAI authors. MIT license.

import * as p from "@clack/prompts";
import { colorize } from "consola/utils";

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
