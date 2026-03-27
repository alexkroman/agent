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

const PERSIST_PREFIX = "__persist:";

export function persistKey(sessionId: string): string {
  return `${PERSIST_PREFIX}${sessionId}`;
}

export type PersistedSession = {
  s2sSessionId: string | null;
  messages: Message[];
  state: Record<string, unknown>;
};

export type SessionPersistence = {
  kv: Kv;
  ttl: number;
  getState: () => Record<string, unknown>;
  setState: (state: Record<string, unknown>) => void;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

type PersistCtx = {
  pushMessages(...msgs: Message[]): void;
  conversationMessages: Message[];
};

export async function restorePersistedSession(
  persistence: SessionPersistence,
  resumeFrom: string,
  ctx: PersistCtx,
  log: Logger,
): Promise<string | null> {
  const persisted = await persistence.kv.get<PersistedSession>(persistKey(resumeFrom));
  if (!persisted) return null;
  log.info("Restoring persisted session", { resumeFrom });
  persistence.setState(persisted.state);
  if (persisted.messages.length > 0) {
    ctx.pushMessages(...persisted.messages);
  }
  return persisted.s2sSessionId;
}

export async function saveSessionData(
  persistence: SessionPersistence,
  sessionId: string,
  ctx: PersistCtx,
  s2sSessionId: string | null,
  log: Logger,
  /** Old session key to clean up (from a previous session we resumed from). */
  cleanupKey?: string,
): Promise<void> {
  const data: PersistedSession = {
    s2sSessionId,
    messages: ctx.conversationMessages,
    state: persistence.getState(),
  };
  const key = persistKey(sessionId);
  const ops: Promise<void>[] = [persistence.kv.set(key, data, { expireIn: persistence.ttl })];
  if (cleanupKey && cleanupKey !== sessionId) {
    ops.push(persistence.kv.delete(persistKey(cleanupKey)));
  }
  await Promise.all(ops);
  log.info("Session persisted", { sessionId });
}
