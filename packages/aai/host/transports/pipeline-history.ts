// Copyright 2026 the AAI authors. MIT license.
/**
 * Conversation memory for a pipeline session.
 *
 * Keeps two parallel views of the dialogue:
 * - `conversation` — text-only {@link Message}s, used for the client protocol,
 *   session resume, and tool context (all of which expect plain text).
 * - `llm` — Vercel AI SDK {@link ModelMessage}s, the source of truth for what
 *   the model actually sees. Each turn appends `streamText`'s per-step response
 *   messages (the assistant tool-call message AND its `tool` result), so tool
 *   calls and their results carry into the next turn — not just spoken text.
 *
 * Both views are capped at {@link DEFAULT_MAX_HISTORY} (oldest trimmed).
 */

import type { ModelMessage } from "ai";
import { DEFAULT_MAX_HISTORY } from "../../sdk/constants.ts";
import type { Message } from "../../sdk/types.ts";
import { toModelMessage } from "./pipeline-stream.ts";

/** Conversation memory handle returned by {@link createPipelineHistory}. */
export interface PipelineHistory {
  /** Text-only history for the client protocol, resume, and tool context. */
  readonly conversation: Message[];
  /** ModelMessage history — what the LLM sees (includes tool calls/results). */
  readonly llm: ModelMessage[];
  /** Append text message(s) to the conversation (client/resume) view. */
  pushConversation(...msgs: Message[]): void;
  /** Append ModelMessage(s) — e.g. a turn's response messages — to the LLM view. */
  pushLlm(...msgs: ModelMessage[]): void;
  /** Seed both views from resent text history (e.g. reconnect/resume). */
  seed(msgs: readonly Message[]): void;
  /** Clear both views. */
  reset(): void;
}

function cap(arr: unknown[]): void {
  if (arr.length > DEFAULT_MAX_HISTORY) {
    arr.splice(0, arr.length - DEFAULT_MAX_HISTORY);
  }
}

/** Create a {@link PipelineHistory}, optionally seeded from prior text history. */
export function createPipelineHistory(seed?: readonly Message[]): PipelineHistory {
  const conversation: Message[] = seed ? [...seed] : [];
  const llm: ModelMessage[] = conversation.map(toModelMessage);

  return {
    conversation,
    llm,
    pushConversation(...msgs: Message[]): void {
      conversation.push(...msgs);
      cap(conversation);
    },
    pushLlm(...msgs: ModelMessage[]): void {
      llm.push(...msgs);
      cap(llm);
    },
    seed(msgs: readonly Message[]): void {
      if (msgs.length === 0) return;
      conversation.push(...msgs);
      cap(conversation);
      llm.push(...msgs.map(toModelMessage));
      cap(llm);
    },
    reset(): void {
      conversation.length = 0;
      llm.length = 0;
    },
  };
}
