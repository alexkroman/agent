// Copyright 2025 the AAI authors. MIT license.

import { log as clackLog } from "@clack/prompts";
import { colorize } from "consola/utils";

type Log = typeof clackLog;

const noop = () => {
  /* no-op */
};
let _delegate: Log = clackLog;

const logHandler: ProxyHandler<Log> = {
  get(_target, prop, receiver) {
    return Reflect.get(_delegate, prop, receiver);
  },
};

/** Log instance that delegates to clack (human mode) or no-ops (JSON mode). */
export const log: Log = new Proxy(clackLog, logHandler);

/** Replace all log methods with no-ops. Call once in JSON mode. */
export function silenceOutput(): void {
  _delegate = {
    info: noop,
    success: noop,
    error: noop,
    warn: noop,
    step: noop,
    message: noop,
  } as unknown as Log;
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
