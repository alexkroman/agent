// Copyright 2025 the AAI authors. MIT license.

import { consola as _consola } from "consola";

/** Shared consola instance with date display disabled. */
export const consola = _consola.create({ formatOptions: { date: false } });

/** Parse and validate a port string. Returns the numeric port or throws. */
export function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  if (Number.isNaN(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${raw}. Must be a number between 0 and 65535.`);
  }
  return port;
}
