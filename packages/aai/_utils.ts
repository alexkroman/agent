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

/**
 * Safely extract the port from `server.address()`, guarding against the
 * string (pipe/socket) and null return types.
 */
export function getServerPort(addr: unknown): number {
  if (
    addr &&
    typeof addr === "object" &&
    "port" in addr &&
    typeof (addr as { port: unknown }).port === "number"
  ) {
    return (addr as { port: number }).port;
  }
  throw new Error(`Expected server address with numeric port, got: ${JSON.stringify(addr)}`);
}

/**
 * Lazily initialized per-session state manager.
 *
 * On first access for a given session, calls `initState()` (if provided) to
 * create the initial state. Returns `{}` if no initializer and no prior state.
 */
export function createSessionStateMap(initState?: () => Record<string, unknown>): {
  get(sessionId: string): Record<string, unknown>;
  /** Explicitly set the state for a session. */
  set(sessionId: string, state: Record<string, unknown>): void;
  delete(sessionId: string): boolean;
} {
  const map = new Map<string, Record<string, unknown>>();
  return {
    get(sessionId: string): Record<string, unknown> {
      if (!map.has(sessionId) && initState) {
        map.set(sessionId, initState());
      }
      return map.get(sessionId) ?? {};
    },
    set(sessionId: string, state: Record<string, unknown>): void {
      map.set(sessionId, state);
    },
    delete(sessionId: string): boolean {
      return map.delete(sessionId);
    },
  };
}

/** Return a JSON error string for the LLM: `'{"error":"<message>"}'`. */
export function toolError(message: string): string {
  return JSON.stringify({ error: message });
}
