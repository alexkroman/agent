// Copyright 2025 the AAI authors. MIT license.

import { log as clackLog } from "@clack/prompts";
import { colorize } from "consola/utils";

type Log = typeof clackLog;

const noop = () => {
  /* noop */
};
let delegate: Log = clackLog;

// Proxy lets `import { log }` consumers see retroactive swaps from silenceOutput().
export const log: Log = new Proxy(clackLog, {
  get: (_t, prop, receiver) => Reflect.get(delegate, prop, receiver),
});

export function silenceOutput(): void {
  delegate = {
    info: noop,
    success: noop,
    error: noop,
    warn: noop,
    step: noop,
    message: noop,
  } as unknown as Log;
}

export function fmtUrl(url: string): string {
  return colorize("cyanBright", url);
}

export function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  if (Number.isNaN(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${raw}. Must be a number between 0 and 65535.`);
  }
  return port;
}
