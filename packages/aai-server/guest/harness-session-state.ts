// Copyright 2026 the AAI authors. MIT license.
/**
 * Per-session ctx.state map for the Deno guest harness. Lazily initialised
 * from the agent's `state()` factory per session; deep-cloned via
 * structuredClone so sessions are isolated.
 *
 * Like every `harness-*.ts` sibling: ZERO workspace imports — inlined into
 * the bundled harness artifact for production, loaded as a static sibling
 * import in dev.
 */

export type SessionStateMap = {
  /** The session's state, minting it from the factory on first access. */
  get(sessionId: string): Record<string, unknown>;
  set(sessionId: string, state: Record<string, unknown>): void;
  /** Read without lazily initialising — session/export must not mint state. */
  peek(sessionId: string): Record<string, unknown> | undefined;
  /**
   * Restore persisted state for a resumed session. Set-if-absent: state
   * already present under this id (same-host resume within the grace
   * window) is at least as fresh as anything persisted, and a restore
   * racing the session's first tool call must not clobber live mutations.
   */
  restore(sessionId: string, state: Record<string, unknown>): void;
  delete(sessionId: string): boolean;
};

export function createSessionStateMap(initState?: () => Record<string, unknown>): SessionStateMap {
  const map = new Map<string, Record<string, unknown>>();
  return {
    get(sessionId) {
      if (!map.has(sessionId)) {
        const initial = initState ? initState() : {};
        map.set(sessionId, structuredClone(initial));
      }
      // map.has() guarantees the key exists after the block above
      return map.get(sessionId) as Record<string, unknown>;
    },
    set(sessionId, state) {
      map.set(sessionId, state);
    },
    peek(sessionId) {
      return map.get(sessionId);
    },
    restore(sessionId, state) {
      if (map.has(sessionId)) return;
      map.set(sessionId, structuredClone(state));
    },
    delete(sessionId) {
      return map.delete(sessionId);
    },
  };
}
