// Copyright 2025 the AAI authors. MIT license.
/** Shared utility functions. */

/** Extract an error message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Filter out undefined values from an env record. */
export function filterEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<
    string,
    string
  >;
}
