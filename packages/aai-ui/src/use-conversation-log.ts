// Copyright 2026 the AAI authors. MIT license.
/**
 * `useConversationLog` — everything this page has said and heard, across
 * sessions, kept in `localStorage`.
 *
 * `useConversation()` is the CURRENT session; a page beside a device holds a
 * new resumable session every few turns, and wants the whole history on screen
 * after a reload. This hook writes the live conversation into a persisted log
 * as it happens — handling the replay a resumed session brings back, so no turn
 * is logged twice (the rules are `conversation-log.ts`'s module doc) — plus the
 * page's own notes, what the device said on its own, and, through `mirror`, the
 * live conversation of the client's OTHER sessions (a linked speaker's).
 *
 * **It opens no inbox socket.** The inbox keeps one socket per (client, holder)
 * and a second from the same tab REPLACES the first, so `mirror` is a handler
 * to hand the page's one `useInbox({ onEvent })`.
 *
 * `<ConversationView log={entries}>` renders it with the kit's own rows.
 *
 * @module
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { storageGet, storageSet, urlSlot } from "./_web-storage.ts";
import { useSessionCore, useSessionSelector } from "./context.ts";
import {
  appendEntry,
  type ConversationLogEntry,
  inboxEventToItem,
  parseLog,
  recordSession,
} from "./conversation-log.ts";
import type { InboxEvent } from "./inbox-protocol.ts";
import type { SessionSnapshot } from "./session/index.ts";
import type { ChatMessage, ToolCallInfo } from "./types.ts";
import { type ConversationItem, interleave } from "./use-conversation.ts";
import { useSessionId } from "./use-session-id.ts";

/**
 * Options for {@link useConversationLog}.
 *
 * @public
 */
export type UseConversationLogOptions = {
  /**
   * The `localStorage` key, read once on mount. Default: one per agent URL, so
   * two agents on one origin keep separate logs.
   */
  storageKey?: string | undefined;
  /** Entries kept; the oldest go first. Default 300 — `localStorage` holds a few MB per origin. */
  max?: number | undefined;
};

/**
 * What {@link useConversationLog} returns.
 *
 * @public
 */
export type UseConversationLogResult = {
  /** The log, oldest first; the live session is its newest session entry. */
  readonly entries: readonly ConversationLogEntry[];
  /** Log a line of the page's own: "New session", "Continuing an earlier conversation". */
  addNote(text: string): void;
  /** Log what the agent said outside a session — a reminder read aloud — as an assistant turn. */
  addSpoken(text: string): void;
  /**
   * Mirror a frame of the client's live conversation into the log — pass it as
   * `useInbox({ onEvent: log.mirror })`. The page's own session is skipped (it
   * logs itself); every other session of the client is logged as it happens.
   */
  mirror(event: InboxEvent): void;
  /** Forget the whole log, stored copy included. */
  clear(): void;
};

const DEFAULT_MAX = 300;
const selectMessages = (s: SessionSnapshot): ChatMessage[] => s.messages;
const selectToolCalls = (s: SessionSnapshot): ToolCallInfo[] => s.toolCalls;

/**
 * A transcript that outlives the session — see this module's doc.
 *
 * Must be used inside the provider `mountClient()` installs; call it once per
 * page, since two logs over one key would overwrite each other.
 *
 * @example The whole history, with a note per new session and a linked speaker mirrored
 * ```tsx
 * import { ConversationView, useConversationLog, useInbox } from "@alexkroman1/aai-ui";
 *
 * function History() {
 *   const log = useConversationLog();
 *   useInbox({ onEvent: log.mirror, onNotice: (n) => log.addNote(n.event) });
 *   return (
 *     <ConversationView
 *       log={log.entries}
 *       className="flex-1 min-h-0"
 *       renderMessage={(m) => <p data-role={m.role}>{m.content}</p>}
 *     />
 *   );
 * }
 * ```
 *
 * @param options - Where it is stored and how much; see {@link UseConversationLogOptions}.
 * @returns The entries and the ways to add to them; see {@link UseConversationLogResult}.
 *
 * @public
 */
export function useConversationLog(
  options: UseConversationLogOptions = {},
): UseConversationLogResult {
  const session = useSessionCore();
  const max = options.max ?? DEFAULT_MAX;
  const [key] = useState(
    () => options.storageKey ?? urlSlot("aai:conversation-log:", session.identity.platformUrl),
  );
  const [entries, setEntries] = useState<readonly ConversationLogEntry[]>(() =>
    parseLog(storageGet("local", key), max),
  );

  // Written back on every change but the first render's, which read it.
  const loaded = useRef(entries);
  useEffect(() => {
    if (entries !== loaded.current) storageSet("local", key, JSON.stringify(entries));
  }, [key, entries]);

  // The live conversation IS the newest session entry.
  const sessionId = useSessionId();
  const messages = useSessionSelector(selectMessages);
  const toolCalls = useSessionSelector(selectToolCalls);
  const items = useMemo(() => interleave(messages, toolCalls), [messages, toolCalls]);
  useEffect(() => {
    if (!sessionId) return;
    const client = session.identity.clientId();
    setEntries((log) => recordSession(log, sessionId, items, Date.now(), max, client));
  }, [session, sessionId, items, max]);

  // Every OTHER session of the client, assembled from its frames.
  const own = useRef(sessionId);
  own.current = sessionId;
  const mirrored = useRef(new Map<string, ConversationItem[]>());
  const mirror = useCallback(
    (event: InboxEvent): void => {
      if (event.sessionId === own.current) return;
      if (event.type === "session_ended") {
        mirrored.current.delete(event.sessionId);
        return;
      }
      const prior = mirrored.current.get(event.sessionId) ?? [];
      const list = settle(prior, event) ?? append(prior, event);
      if (!list) return;
      mirrored.current.set(event.sessionId, list);
      const client = session.identity.clientId();
      setEntries((log) => recordSession(log, event.sessionId, list, Date.now(), max, client));
    },
    [session, max],
  );

  const addNote = useCallback(
    (text: string) =>
      setEntries((log) => appendEntry(log, { kind: "note", at: Date.now(), text }, max)),
    [max],
  );
  const addSpoken = useCallback(
    (text: string) =>
      setEntries((log) => appendEntry(log, { kind: "spoken", at: Date.now(), text }, max)),
    [max],
  );
  const clear = useCallback(() => setEntries([]), []);

  return useMemo(
    () => ({ entries, addNote, addSpoken, mirror, clear }),
    [entries, addNote, addSpoken, mirror, clear],
  );
}

/** A mirrored tool call completing: the same list with that call done, or undefined. */
function settle(
  list: ConversationItem[],
  event: Extract<InboxEvent, { type: "session_event" }>,
): ConversationItem[] | undefined {
  if (event.event.type !== "tool.completed") return undefined;
  const id = event.event.toolCallId;
  const at = list.findIndex((it) => it.kind === "tool" && it.toolCall.callId === id);
  const hit = list[at];
  if (hit?.kind !== "tool") return list;
  const next = [...list];
  next[at] = { kind: "tool", toolCall: { ...hit.toolCall, status: "done" } };
  return next;
}

/** A mirrored frame that is a new item: the list with it on the end, or undefined. */
function append(
  list: ConversationItem[],
  event: Extract<InboxEvent, { type: "session_event" }>,
): ConversationItem[] | undefined {
  const item = inboxEventToItem(event, list.length);
  return item ? [...list, item] : undefined;
}
