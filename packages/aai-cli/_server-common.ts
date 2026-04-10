// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { parseEnvFile } from "aai";

export { parseEnvFile } from "aai";

/**
 * Build the `ctx.env` record that agent tools will see at runtime.
 *
 * Only variables explicitly declared in `.env` are included — matching
 * the platform sandbox behavior where `ctx.env`
 * contains only secrets set via `aai secret put`. This prevents agents
 * from accidentally depending on shell-level vars (PATH, HOME, etc.) that
 * won't exist in production.
 *
 * Values are resolved by merging the `.env` file with the current
 * environment — existing shell exports take precedence over `.env`
 * defaults, without mutating `process.env`.
 *
 * @param cwd - Project directory containing `.env` (optional).
 * @param baseEnv - Override the environment to read values from (tests only).
 */
export async function resolveServerEnv(
  cwd?: string,
  baseEnv?: Record<string, string | undefined>,
): Promise<Record<string, string>> {
  let fileEntries: Record<string, string> = {};
  if (cwd) {
    try {
      const content = await fs.readFile(path.join(cwd, ".env"), "utf-8");
      fileEntries = parseEnvFile(content);
    } catch {
      // No .env file — that's fine
    }
  }

  const source = baseEnv ?? process.env;

  // Only include explicitly-declared keys (not all of process.env).
  // Shell env takes precedence over .env file values.
  const env: Record<string, string> = {};
  for (const [key, fileVal] of Object.entries(fileEntries)) {
    const val = source[key] ?? fileVal;
    if (val !== undefined) env[key] = val;
  }

  return env;
}
