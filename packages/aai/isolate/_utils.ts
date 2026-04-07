// Copyright 2025 the AAI authors. MIT license.
/** Shared utility functions. */

/** Extract an error message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse a `.env` file into a key→value record.
 *
 * Skips blank lines and comments (`#`). For each remaining line, splits
 * on the first `=` to produce a key/value pair. Shell overrides still
 * win because callers merge with `process.env` separately.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key) entries[key] = line.slice(eq + 1);
  }
  return entries;
}

/** Extract a detailed error string (message + stack) for diagnostic logging. */
export function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}

/** Return a JSON error string for the LLM: `'{"error":"<message>"}'`. */
export function toolError(message: string): string {
  return JSON.stringify({ error: message });
}
