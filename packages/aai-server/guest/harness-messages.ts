// Copyright 2026 the AAI authors. MIT license.
/**
 * Per-session conversation-history cache for the guest harness, plus the
 * wire-protocol pieces of the incremental `tool/execute` messages delta.
 *
 * `tool/execute` used to ship the full transcript (up to 200 messages) on
 * every call, so late-session tool calls paid stringify + pipe + parse of
 * the whole history per step — repeated per step in multi-tool turns. The
 * host now sends a delta:
 *
 * - `messagesMode: "full"` (or absent — callers that predate the delta
 *   protocol, e.g. the studio trial runner, send plain `messages`) replaces
 *   the session's cached history with `messages`.
 * - `messagesMode: "append"` carries only the messages after
 *   `messagesBase`; the guest verifies its cache is exactly `messagesBase`
 *   long and appends. On any mismatch (guest restarted, cache evicted, host
 *   lost track after a failed send) `apply` returns null, the harness
 *   answers `{ error: MESSAGES_DESYNC_ERROR }`, and the host retries the
 *   call with full history.
 *
 * This module is imported by BOTH sides of the boundary — the guest harness
 * (deno-harness.ts) and the host (sandbox.ts) — like guest/limits.ts, so the
 * sentinel and mode strings cannot drift. Dependency-free: it is bundled
 * into the self-contained guest artifact.
 */

import type { Message } from "./harness-types.ts";

/** How the `messages` field of a `tool/execute` request must be applied. */
export type MessagesMode = "full" | "append";

/**
 * Error string the guest returns when an append cannot be applied. The host
 * matches it exactly and retries the same call with full history.
 */
export const MESSAGES_DESYNC_ERROR = "messages_desync";

/**
 * Sessions cached at once, per harness. Bounds guest memory (64 MB cgroup):
 * an evicted session's next append desyncs, the host resends full history,
 * and the cache self-heals — eviction costs one extra full send, never
 * correctness. Sessions are also dropped eagerly on `session/end`.
 */
export const MAX_MESSAGE_CACHE_SESSIONS = 16;

export type SessionMessagesCache = {
  /**
   * Apply a `tool/execute` messages delta and return the session's full
   * history (a shallow copy — tools may mutate the array they are handed),
   * or null when an append cannot be applied (desync).
   */
  apply(
    sessionId: string,
    messages: Message[],
    mode: MessagesMode | undefined,
    base: number | undefined,
  ): Message[] | null;
  /** Drop a session's cached history (session ended). */
  delete(sessionId: string): void;
  /** Number of sessions currently cached (exposed for tests). */
  size(): number;
};

export function createSessionMessagesCache(
  maxSessions: number = MAX_MESSAGE_CACHE_SESSIONS,
): SessionMessagesCache {
  // Map iteration order is insertion order; delete+set on every apply makes
  // the first key the least-recently-used session.
  const cache = new Map<string, Message[]>();

  function touch(sessionId: string, history: Message[]): void {
    cache.delete(sessionId);
    cache.set(sessionId, history);
    if (cache.size > maxSessions) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  return {
    apply(sessionId, messages, mode, base) {
      if (mode === "append") {
        const cached = cache.get(sessionId);
        if (!cached || cached.length !== base) return null;
        cached.push(...messages);
        touch(sessionId, cached);
        return cached.slice();
      }
      // Full replacement. The parsed request owns `messages`, so it can be
      // stored directly; hand tools a copy so they can't corrupt the cache.
      touch(sessionId, messages);
      return messages.slice();
    },
    delete(sessionId) {
      cache.delete(sessionId);
    },
    size() {
      return cache.size;
    },
  };
}
