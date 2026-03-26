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

/** Set of filesystem operations that are safe for read-only access. */
const READ_ONLY_FS_OPS = new Set(["read", "stat", "readdir", "exists"]);

/** Check whether a filesystem operation is a read-only operation. */
export function isReadOnlyFsOp(op: string): boolean {
  return READ_ONLY_FS_OPS.has(op);
}

/** WebSocket readyState constant for OPEN (1). */
export const WS_OPEN = 1;

/** Filter out undefined values from an env record. */
export function filterEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
}
