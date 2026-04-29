// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { parse as dotenvParse } from "dotenv";

export function parseEnvFile(content: string): Record<string, string> {
  return dotenvParse(content);
}

async function readEnvFile(cwd: string): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(path.join(cwd, ".env"), "utf-8");
    return dotenvParse(content);
  } catch {
    return {};
  }
}

/**
 * Build the `ctx.env` record agent tools see at runtime.
 *
 * Only keys declared in `.env` are surfaced — matches platform sandbox behavior
 * (`ctx.env` only contains secrets set via `aai secret put`) and prevents
 * agents from leaning on shell vars (PATH, HOME, ...) that won't exist in prod.
 * Shell env takes precedence over `.env` values; `process.env` is not mutated.
 */
export async function resolveServerEnv(
  cwd?: string,
  baseEnv?: Record<string, string | undefined>,
): Promise<Record<string, string>> {
  const fileEntries = cwd ? await readEnvFile(cwd) : {};
  const source = baseEnv ?? process.env;

  const env: Record<string, string> = {};
  for (const [key, fileVal] of Object.entries(fileEntries)) {
    env[key] = source[key] ?? fileVal;
  }
  return env;
}
