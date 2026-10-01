// Copyright 2026 the AAI authors. MIT license.
/**
 * A transcript that outlives the session: the pure half of
 * `useConversationLog`, with no React and no storage.
 *
 * A page beside a device holds many SHORT, resumable sessions (tap, a few
 * turns, a hang-up, and the next tap resumes), and the live conversation the
 * session holds is only ever the current one. This log keeps the rest, in the
 * order things happened, interleaved with notes and what the device said on
 * its own.
 *
 * ## A resume replays, so the live list is never appended as it stands
 *
 * A resumed session's turns come back (`history.restored`) — appending the live
 * list would log every earlier turn again. Each server session is instead a
 * CHAIN of entries whose items, end to end, are its conversation: the chain is
 * rewritten from the live list and only what is new goes on the end — in a NEW
 * entry when something else (a note, a notice) was logged since, so the log
 * stays in order. A session the server had already retired comes back under
 * the same id but EMPTY and greeting; it continues the chain only if every turn
 * the two share matches, and starts a new `run` otherwise, so it cannot
 * overwrite what the old one said.
 *
 * @module
 */

import { isRecord } from "@alexkroman1/aai/utils";
import type { InboxEvent } from "./inbox-protocol.ts";
import type { ChatMessage, ToolCallInfo } from "./types.ts";
import type { ConversationItem } from "./use-conversation.ts";

/**
 * One entry of a {@link useConversationLog} transcript.
 *
 * - `session` — a stretch of one server session's conversation. `run` tells
 *   apart two conversations the server held under one id (a retired session
 *   that came back empty); `clientId` is whose it was — this browser's own or
 *   a linked device's, since only the page's CURRENT client can resume one.
 *   Tool calls are stored without their `result`, which is the agent's to keep
 *   and can be large.
 * - `note` — a line the page logged itself (`addNote`): "New session".
 * - `spoken` — what the agent said on its own, outside a session (a reminder
 *   read aloud): rendered as an assistant turn.
 *
 * @public
 */
export type ConversationLogEntry =
  | {
      readonly kind: "session";
      readonly sessionId: string;
      readonly run: number;
      /** When the entry was started, epoch ms. */
      readonly at: number;
      readonly items: readonly ConversationItem[];
      readonly clientId?: string;
    }
  | { readonly kind: "note"; readonly at: number; readonly text: string }
  | { readonly kind: "spoken"; readonly at: number; readonly text: string };

type SessionEntry = Extract<ConversationLogEntry, { kind: "session" }>;

/** The item as the log keeps it: a tool call's `result` dropped. */
export function logItem(item: ConversationItem): ConversationItem {
  if (item.kind === "message" || item.toolCall.result === undefined) return item;
  const { result: _result, ...toolCall } = item.toolCall;
  return { kind: "tool", toolCall };
}

/** One item's identity as a turn — ignoring ids and a tool call going pending → done. */
function turnKey(item: ConversationItem | undefined): string {
  if (!item) return "";
  return item.kind === "message"
    ? `m${item.message.role}:${item.message.content}`
    : `t${item.toolCall.name}:${JSON.stringify(item.toolCall.args)}`;
}

/** The same turn in the same state — what makes a rewrite a no-op. */
function sameItem(a: ConversationItem, b: ConversationItem | undefined): boolean {
  if (turnKey(a) !== turnKey(b)) return false;
  return a.kind !== "tool" || (b?.kind === "tool" && a.toolCall.status === b.toolCall.status);
}

/** Keep the newest `max`; the oldest go first. */
function trim(log: ConversationLogEntry[], max: number): ConversationLogEntry[] {
  return log.length > max ? log.slice(-max) : log;
}

/** Add an entry at the end. */
export function appendEntry(
  log: readonly ConversationLogEntry[],
  entry: ConversationLogEntry,
  max: number,
): ConversationLogEntry[] {
  return trim([...log, entry], max);
}

/**
 * Write the live conversation of `sessionId` into the log — see the module
 * doc. Returns `log` itself when nothing changed, so a caller can skip a render.
 */
export function recordSession(
  log: readonly ConversationLogEntry[],
  sessionId: string,
  live: readonly ConversationItem[],
  now: number,
  max: number,
  clientId?: string,
): readonly ConversationLogEntry[] {
  if (live.length === 0) return log;
  const items = live.map(logItem);
  const owner = clientId ? { clientId } : {};
  const mine = (e: ConversationLogEntry): e is SessionEntry =>
    e.kind === "session" && e.sessionId === sessionId;
  const run = log.findLast(mine)?.run ?? 0;
  const chain = log.flatMap((e, i) => (mine(e) && e.run === run ? [i] : []));
  const stored = chain.flatMap((i) => (log[i] as SessionEntry).items);
  // EVERY shared turn must match, not just the first: a session the server lost
  // comes back greeting, and the greeting is the old one's first turn too.
  const shared = Math.min(stored.length, items.length);
  const continues =
    chain.length > 0 && stored.slice(0, shared).every((it, k) => turnKey(it) === turnKey(items[k]));
  if (!continues) {
    const fresh = chain.length > 0 ? run + 1 : 0;
    return appendEntry(
      log,
      { kind: "session", sessionId, run: fresh, at: now, items, ...owner },
      max,
    );
  }
  // Mid-replay, before the whole restored history has landed: nothing new.
  if (items.length < stored.length) return log;

  const next = [...log];
  let offset = 0;
  let changed = false;
  for (const i of chain) {
    const e = next[i] as SessionEntry;
    const slice = items.slice(offset, offset + e.items.length);
    if (slice.some((it, k) => !sameItem(it, e.items[k]))) {
      next[i] = { ...e, items: slice };
      changed = true;
    }
    offset += e.items.length;
  }
  const rest = items.slice(offset);
  if (rest.length === 0) return changed ? next : log;
  const tail = chain.at(-1) as number;
  if (tail === next.length - 1) {
    const e = next[tail] as SessionEntry;
    next[tail] = { ...e, items: [...e.items, ...rest] };
    return next;
  }
  return appendEntry(
    next,
    { kind: "session", sessionId, run, at: now, items: rest, ...owner },
    max,
  );
}

/**
 * The log item for one frame of a client's live conversation — what
 * `useInbox({ onEvent })` delivers for another session of the same client (a
 * device's, when the page is linked to one) — or `undefined` for a frame that
 * is not shown: a partial transcript, a recovery phrase ("sorry, say that
 * again", the agent's filler rather than a reply), a tool's completion, a
 * `session_ended`.
 *
 * `useConversationLog().mirror` is built on this; call it yourself to render
 * another session some other way.
 *
 * @param event - The inbox frame.
 * @param id - The id to give the item: its index in that session's list, say.
 *   Messages take it as `id`, tool calls as `seq`.
 * @returns A committed user or assistant turn, a tool call (pending), or `undefined`.
 *
 * @public
 */
export function inboxEventToItem(event: InboxEvent, id = 0): ConversationItem | undefined {
  if (event.type !== "session_event") return undefined;
  const e = event.event;
  const text = typeof e.text === "string" ? e.text.trim() : "";
  switch (e.type) {
    case "userTranscript.committed":
      return text ? message(id, "user", text) : undefined;
    case "agentTranscript.committed":
      return text && !e.recovery ? message(id, "assistant", text) : undefined;
    case "tool.called":
      return mirroredToolCall(e, id);
    default:
      return undefined;
  }
}

/** A `tool.called` frame as a pending tool row, or undefined without a tool name. */
function mirroredToolCall(
  e: Readonly<Record<string, unknown>>,
  id: number,
): ConversationItem | undefined {
  if (typeof e.toolName !== "string") return undefined;
  const toolCall: ToolCallInfo = {
    callId: typeof e.toolCallId === "string" ? e.toolCallId : `mirrored-${id}`,
    name: e.toolName,
    args: isRecord(e.args) ? e.args : {},
    status: "pending",
    seq: id,
    afterMessageId: -1,
  };
  return { kind: "tool", toolCall };
}

function message(id: number, role: ChatMessage["role"], content: string): ConversationItem {
  return { kind: "message", message: { id, role, content } };
}

// ─── Reading a stored log back ─────────────────────────────────────────────

/** A stored item, or undefined: storage is another page's writing, so every field is checked. */
function parseItem(raw: unknown): ConversationItem | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.kind === "message" && isRecord(raw.message)) return parseMessage(raw.message);
  if (raw.kind === "tool" && isRecord(raw.toolCall)) return parseToolCall(raw.toolCall);
  return undefined;
}

function parseMessage(raw: Record<string, unknown>): ConversationItem | undefined {
  const { id, role, content } = raw;
  if (typeof id !== "number" || typeof content !== "string") return undefined;
  return role === "user" || role === "assistant" ? message(id, role, content) : undefined;
}

function parseToolCall(raw: Record<string, unknown>): ConversationItem | undefined {
  const { callId, name, args, status, seq, afterMessageId } = raw;
  if (typeof callId !== "string" || typeof name !== "string" || !isRecord(args)) return undefined;
  const toolCall: ToolCallInfo = {
    callId,
    name,
    args,
    status: status === "pending" ? "pending" : "done",
    seq: typeof seq === "number" ? seq : 0,
    afterMessageId: typeof afterMessageId === "number" ? afterMessageId : -1,
  };
  return { kind: "tool", toolCall };
}

function parseEntry(raw: unknown): ConversationLogEntry | undefined {
  if (!isRecord(raw) || typeof raw.at !== "number") return undefined;
  const { at } = raw;
  if ((raw.kind === "note" || raw.kind === "spoken") && typeof raw.text === "string") {
    return { kind: raw.kind, at, text: raw.text };
  }
  if (raw.kind !== "session" || typeof raw.sessionId !== "string" || !Array.isArray(raw.items)) {
    return undefined;
  }
  const items = raw.items.map(parseItem);
  if (items.some((it) => it === undefined)) return undefined;
  return {
    kind: "session",
    sessionId: raw.sessionId,
    run: typeof raw.run === "number" ? raw.run : 0,
    at,
    items: items as ConversationItem[],
    ...(typeof raw.clientId === "string" ? { clientId: raw.clientId } : {}),
  };
}

/** A stored log, with anything malformed dropped — never a throw. */
export function parseLog(raw: string | undefined, max: number): ConversationLogEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries = parsed.map(parseEntry).filter((e) => e !== undefined);
  return trim(entries, max);
}
