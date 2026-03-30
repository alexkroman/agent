// Copyright 2025 the AAI authors. MIT license.
/** Shared utility functions. */

/** Extract an error message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
