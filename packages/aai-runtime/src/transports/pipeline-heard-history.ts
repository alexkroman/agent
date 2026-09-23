// Copyright 2026 the AAI authors. MIT license.
/**
 * Take back the unheard tail of a reply that was ALREADY committed to history.
 *
 * `persistBargeIn` (`pipeline-turn-outcome.ts`) records only the heard prefix
 * of a reply — but only when the barge-in aborts the turn BODY. The body
 * commits the whole reply the moment its LLM stream ends, and what follows is
 * synthesis and playback: the TTS drain, then however much audio the client
 * still holds (8-15s is ordinary). Measured on a tau2-bench voice run, 35 of
 * 36 barge-ins landed in that window, so the reply stayed in history as if
 * heard while the client discarded up to 15s of it — and the model, believing
 * it had delivered a refund destination or a confirmation address, did not
 * repeat it.
 *
 * So a committed reply registers itself with the heard cursor
 * (`HeardTracker.markPersisted`), and a cut that finds its audio still playing
 * rewrites the record here, to the same shape `persistInterruptedTurn` writes:
 * the heard prefix marked `[interrupted]`, or no assistant text at all when
 * nothing was heard. Tool calls and their results are never touched — the
 * calls really ran, for the reason `persistInterruptedTurn` keeps them.
 *
 * Nothing is emitted to the client, for the reason `persistInterruptedTurn`
 * gives: its committed transcript already went out, and correcting it after
 * `cancelled` is the measured double-transcript bug.
 */

import type { Message } from "@alexkroman1/aai";
import type { AssistantModelMessage, ModelMessage } from "ai";
import type { Logger } from "../runtime-config.ts";
import type { HeardPosition, HeardTracker } from "./pipeline-heard.ts";
import { markInterrupted, type PipelineHistory } from "./pipeline-history.ts";
import type { TurnGate } from "./pipeline-turn-gate.ts";

/** What one completed reply left in history. */
export interface PersistedReply {
  /** The reply's recorded text — what `HeardPosition.recordableChars` indexes. */
  text: string;
  /** The conversation-view assistant message carrying {@link text}. */
  conversation: Message | undefined;
  /** The LLM-view messages the turn pushed, as stored. */
  llm: readonly ModelMessage[];
}

type AssistantPart = Exclude<AssistantModelMessage["content"], string>[number];

/** One text part of the reply, placed on {@link PersistedReply.text}. */
interface TextSegment {
  part: AssistantPart & { type: "text" };
  /** Characters of this part the caller heard. */
  keep: number;
}

/**
 * The reply's assistant messages as part lists, and every text part placed on
 * the reply's text with how much of it was heard.
 *
 * The part lists are built ONCE and edited by identity: a string-content
 * message becomes a fresh one-part list here, so building it a second time
 * would hand the editor parts no edit is keyed on.
 *
 * Located rather than summed: the stream handler may inject a separator space
 * between parts (`emitText`), so the recorded text is the parts' concatenation
 * give or take a character per boundary.
 */
function segmentsOf(
  reply: PersistedReply,
  heardChars: number,
): { messages: Map<AssistantModelMessage, AssistantPart[]>; segments: TextSegment[] } {
  const messages = new Map<AssistantModelMessage, AssistantPart[]>();
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const message of reply.llm) {
    if (message.role !== "assistant") continue;
    const parts: AssistantPart[] =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
    messages.set(message, parts);
    for (const part of parts) {
      if (part.type !== "text") continue;
      const found = reply.text.indexOf(part.text, cursor);
      const start = found < 0 ? cursor : found;
      cursor = start + part.text.length;
      segments.push({ part, keep: Math.min(part.text.length, Math.max(0, heardChars - start)) });
    }
  }
  return { messages, segments };
}

/**
 * The replacement for each text part that changes: cut to its heard prefix
 * plus the marker, or `null` (dropped). The marker lands on the LAST part that
 * keeps anything, since everything after it is gone; earlier parts stay whole.
 */
function textEdits(segments: readonly TextSegment[]): Map<AssistantPart, AssistantPart | null> {
  const edits = new Map<AssistantPart, AssistantPart | null>();
  let lastKept = -1;
  segments.forEach((s, i) => {
    if (s.part.text.slice(0, s.keep).trim().length > 0) lastKept = i;
  });
  segments.forEach((segment, i) => {
    if (i > lastKept) edits.set(segment.part, null);
    else if (i === lastKept) {
      const heard = segment.part.text.slice(0, segment.keep).trimEnd();
      edits.set(segment.part, { ...segment.part, text: markInterrupted(heard) });
    }
  });
  return edits;
}

/**
 * One assistant message with its text parts edited, or `null` when nothing
 * worth replaying is left. A message left holding only `reasoning` goes too: a
 * reasoning item with no output after it is not a turn the provider produced.
 */
function editMessage(
  message: AssistantModelMessage,
  parts: readonly AssistantPart[],
  edits: ReadonlyMap<AssistantPart, AssistantPart | null>,
): ModelMessage | null {
  const kept: AssistantPart[] = [];
  for (const part of parts) {
    const next = edits.has(part) ? edits.get(part) : part;
    if (next) kept.push(next);
  }
  if (!kept.some((part) => part.type !== "reasoning")) return null;
  const only = kept.length === 1 ? kept[0] : undefined;
  if (typeof message.content === "string" && only?.type === "text") {
    return { ...message, content: only.text };
  }
  return { ...message, content: kept };
}

/** Edits for every assistant message of the reply that has text to change. */
function llmEdits(
  reply: PersistedReply,
  heardChars: number,
): Map<ModelMessage, ModelMessage | null> {
  const { messages, segments } = segmentsOf(reply, heardChars);
  const parts = textEdits(segments);
  const edits = new Map<ModelMessage, ModelMessage | null>();
  for (const [message, list] of messages) {
    if (list.some((part) => parts.has(part))) edits.set(message, editMessage(message, list, parts));
  }
  return edits;
}

/**
 * Rewrite `reply` in `history` to the prefix the caller heard. Answers the
 * character counts when the record changed, `undefined` when there was nothing
 * unheard to take back or the reply is no longer in history.
 */
export function truncateToHeard(
  history: PipelineHistory,
  reply: PersistedReply,
  heardChars: number,
): { removedChars: number; keptChars: number } | undefined {
  const cutAt = Math.min(Math.max(0, heardChars), reply.text.length);
  if (reply.text.slice(cutAt).trim().length === 0) return;
  const heard = reply.text.slice(0, cutAt).trim();
  const conversation = new Map<Message, Message | null>();
  if (reply.conversation !== undefined) {
    const kept =
      heard.length > 0 ? { ...reply.conversation, content: markInterrupted(heard) } : null;
    conversation.set(reply.conversation, kept);
  }
  if (!history.rewrite({ conversation, llm: llmEdits(reply, cutAt) })) return;
  return { removedChars: reply.text.length - cutAt, keptChars: heard.length };
}

/** Wire committed replies to the heard cursor — see the module doc. */
export function createHeardHistory(deps: {
  history: PipelineHistory;
  heard: HeardTracker;
  gate: TurnGate;
  log: Logger;
  sid: string;
}): (reply: PersistedReply, historyEpoch: number) => void {
  return (reply, historyEpoch) => {
    deps.heard.markPersisted((at: HeardPosition) => {
      // A reset since the commit: the record this would rewrite is gone, and a
      // fresh conversation must not be edited on the old one's behalf.
      if (!deps.gate.historyCurrent(historyEpoch)) return;
      const cut = truncateToHeard(deps.history, reply, at.recordableChars);
      if (cut !== undefined) {
        deps.log.info("Pipeline heard-history truncated", { sid: deps.sid, ...cut });
      }
    });
  };
}
