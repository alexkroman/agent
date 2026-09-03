// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { errorCode } from "./_utils.ts";

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
    let content: string | null = null;
    try {
      content = await fs.readFile(path.join(cwd, ".env"), "utf-8");
    } catch (err) {
      // No .env file is fine; an unreadable one is not — the agent would
      // otherwise run with no secrets and fail later as an opaque auth error.
      if (errorCode(err) !== "ENOENT") throw err;
    }
    if (content !== null) {
      // Node's built-in dotenv-syntax parser (quotes, comments, multiline) —
      // replaced the `dotenv` package, whose only use was this one call.
      fileEntries = parseEnv(content) as Record<string, string>;
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
