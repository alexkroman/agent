// Copyright 2025 the AAI authors. MIT license.
/**
 * Session persistence helpers.
 *
 * Saves and restores session state, conversation messages, and S2S session ID
 * to/from the KV store for cross-reconnect session recovery.
 */

import type { Kv } from "./kv.ts";
import type { Logger } from "./runtime.ts";
import type { Message } from "./types.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

/** KV key prefix for persisted session data. */
export const PERSIST_PREFIX = "__persist:";

/** Shape of the data persisted to KV for session recovery. */
export type PersistedSession = {
  s2sSessionId: string | null;
  messages: Message[];
  state: Record<string, unknown>;
};

/** Persistence configuration passed into session creation. */
export type SessionPersistence = {
  kv: Kv;
  ttl: number;
  getState: () => Record<string, unknown>;
  setState: (state: Record<string, unknown>) => void;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal interface for the session context fields used by persistence. */
type PersistCtx = {
  pushMessages(...msgs: Message[]): void;
  conversationMessages: Message[];
};

/** Load persisted session data from KV and restore state + messages. */
export async function restorePersistedSession(
  persistence: SessionPersistence,
  resumeFrom: string,
  ctx: PersistCtx,
  log: Logger,
): Promise<string | null> {
  const persisted = await persistence.kv.get<PersistedSession>(`${PERSIST_PREFIX}${resumeFrom}`);
  if (!persisted) return null;
  log.info("Restoring persisted session", { resumeFrom });
  persistence.setState(persisted.state);
  if (persisted.messages.length > 0) {
    ctx.pushMessages(...persisted.messages);
  }
  // Clean up old persisted data
  await persistence.kv.delete(`${PERSIST_PREFIX}${resumeFrom}`);
  return persisted.s2sSessionId;
}

/** Save session data to KV for later resume. */
export async function saveSessionData(
  persistence: SessionPersistence,
  sessionId: string,
  ctx: PersistCtx,
  s2sSessionId: string | null,
  log: Logger,
): Promise<void> {
  const data: PersistedSession = {
    s2sSessionId,
    messages: ctx.conversationMessages,
    state: persistence.getState(),
  };
  await persistence.kv.set(`${PERSIST_PREFIX}${sessionId}`, data, {
    expireIn: persistence.ttl,
  });
  log.info("Session persisted", { sessionId });
}
