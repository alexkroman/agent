// Copyright 2026 the AAI authors. MIT license.
/**
 * Persistence for studio project chat conversations — one row per project
 * holding the full UIMessage list, so reopening a project in the studio
 * restores its chat history. Same split as `workspace-store.ts`: a Postgres
 * implementation over the platform's `SqlExec` for production, a Map-backed
 * one with identical semantics for local dev and tests.
 *
 * Deliberately **no version column**, unlike the workspace store. The row is
 * always the authoritative full conversation, written server-side exactly
 * once per turn when the chat stream settles — and a chat has one writer
 * surface (the browser serializes its own turns through `useChat`, and each
 * turn resends the whole history). A concurrent write can only be the same
 * conversation racing itself, where last-write-wins of a full snapshot is
 * already the right outcome; optimistic concurrency would add a conflict
 * path with nothing sensible to do on it.
 *
 * Bounded storage: `putChat` keeps only the most recent messages that fit in
 * {@link MAX_STUDIO_CHAT_STORE_BYTES} serialized, trimming whole messages
 * from the front — a chat must never grow a row unboundedly.
 *
 * The table lives in the `aai_platform` schema (see workspace-store.ts for
 * why platform-internal tables get their own namespace).
 */

import { projectKey } from "./platform-events.ts";
import type { SqlExec } from "./secret-store.ts";

/**
 * Byte budget for one stored conversation, measured on the serialized
 * message array. 512 KB comfortably holds the recent history the coding
 * agent needs for context while keeping the jsonb row bounded.
 */
export const MAX_STUDIO_CHAT_STORE_BYTES = 512 * 1024;

export type ChatStore = {
  /** The stored message list, or null when the project has no chat yet. */
  getChat(scope: string, project: string): Promise<unknown[] | null>;
  /** Replace the conversation (plain upsert; trimmed to the byte budget). */
  putChat(scope: string, project: string, messages: unknown[]): Promise<void>;
  /** Remove the row. Idempotent. */
  deleteChat(scope: string, project: string): Promise<void>;
};

/**
 * Keep the most recent messages whose combined serialization fits the byte
 * budget, dropping whole messages from the front. A newest message that
 * alone exceeds the budget yields an empty list — a truncated half-message
 * would be worse than none, and the client still holds the live turn.
 */
export function trimChatToByteBudget(
  messages: unknown[],
  budget = MAX_STUDIO_CHAT_STORE_BYTES,
): unknown[] {
  return trimChat(messages, budget).trimmed;
}

/**
 * The trim core, keeping the per-message serializations it already computed
 * so `putChat` can build the row payload without a second stringify pass
 * over the same messages.
 */
function trimChat(messages: unknown[], budget: number): { trimmed: unknown[]; parts: string[] } {
  // `[]` serializes to 2 bytes; per-element separators are 1 byte each. Close
  // enough to count per-message bytes + a comma, which slightly overcounts —
  // erring under the budget, never over.
  let total = 2;
  let start = messages.length;
  const parts: string[] = [];
  while (start > 0) {
    const json = JSON.stringify(messages[start - 1]);
    const size = Buffer.byteLength(json) + 1;
    if (total + size > budget) break;
    parts.push(json);
    total += size;
    start -= 1;
  }
  parts.reverse();
  return { trimmed: start === 0 ? messages : messages.slice(start), parts };
}

const TABLE = "aai_platform.studio_chats";

/**
 * Postgres-backed chat store over the platform admin connection. The table is
 * declared in `supabase/migrations`, so this store issues no DDL; it shares
 * the workspace store's string-or-object jsonb read tolerance.
 */
export function createPgChatStore(sql: SqlExec): ChatStore {
  return {
    async getChat(scope, project) {
      const rows = await sql(`select messages from ${TABLE} where scope = $1 and project = $2`, [
        scope,
        project,
      ]);
      const value = rows[0]?.messages;
      if (value === undefined) return null;
      // A malformed row reads as "no chat" rather than surfacing downstream.
      return Array.isArray(value) ? value : null;
    },

    async putChat(scope, project, messages) {
      const json = `[${trimChat(messages, MAX_STUDIO_CHAT_STORE_BYTES).parts.join(",")}]`;
      await sql(
        `insert into ${TABLE} (scope, project, messages) values ($1, $2, $3::text::jsonb)
         on conflict (scope, project) do update set messages = excluded.messages, updated_at = now()`,
        [scope, project, json],
      );
    },

    async deleteChat(scope, project) {
      await sql(`delete from ${TABLE} where scope = $1 and project = $2`, [scope, project]);
    },
  };
}

/**
 * In-memory chat store for local dev and tests. Same semantics as the
 * Postgres store, byte budget included; messages are cloned on both sides
 * so callers never share mutable state with the store (parity with the
 * jsonb round trip).
 */
export function createMemoryChatStore(): ChatStore {
  const rows = new Map<string, unknown[]>();
  // `projectKey` (platform-events.ts) rather than a hand-rolled
  // `${scope}/${project}`: the declared spelling is NUL-separated so no
  // (scope, project) pair can spell another's key, and a second grammar here
  // gives that up for as long as both halves happen to exclude a slash.
  const key = projectKey;

  return {
    getChat(scope, project) {
      const messages = rows.get(key(scope, project));
      return Promise.resolve(messages ? structuredClone(messages) : null);
    },

    putChat(scope, project, messages) {
      rows.set(key(scope, project), structuredClone(trimChatToByteBudget(messages)));
      return Promise.resolve();
    },

    deleteChat(scope, project) {
      rows.delete(key(scope, project));
      return Promise.resolve();
    },
  };
}
