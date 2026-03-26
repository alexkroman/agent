// Copyright 2025 the AAI authors. MIT license.
/** Shared utility functions. */

export { errorDetail, errorMessage, filterEnv } from "./utils.ts";

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
    delete(sessionId: string): boolean {
      return map.delete(sessionId);
    },
  };
}

/**
 * Create a standardized tool error result string.
 *
 * All tool errors — validation failures, execution throws, timeouts, refusals,
 * and middleware blocks — are returned to the LLM as a JSON string with an
 * `error` field: `'{"error":"<message>"}'`. This ensures the LLM always
 * receives a consistent, parseable error format regardless of the failure mode.
 *
 * Tool errors are **never thrown** — they are always caught and converted to
 * this format so the agentic loop can continue.
 */
export function toolError(message: string): string {
  return JSON.stringify({ error: message });
}
