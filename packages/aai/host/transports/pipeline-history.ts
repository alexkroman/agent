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

/**
 * A `reasoning` part is worth replaying only if it carries provider metadata
 * that the originating provider needs to reconstruct the turn:
 * - Anthropic thinking blocks (`anthropic.signature`) or redacted thinking
 *   (`anthropic.redactedData`) replay as real `thinking`/`redacted_thinking`.
 * - OpenAI Responses reasoning items (`openai.itemId`, e.g. `rs_...`) are
 *   REQUIRED alongside the message/tool-call items they produced — dropping one
 *   makes the API reject the whole request ("Item 'msg_...' of type 'message'
 *   was provided without its required 'reasoning' item: 'rs_...'").
 *
 * A metadata-less reasoning part is an ephemeral trace with no valid signature;
 * Anthropic warns ("unsupported reasoning metadata") and drops it on replay, so
 * we strip those ourselves rather than re-send them every turn.
 */
function isReplayableReasoning(
  providerOptions: Record<string, Record<string, unknown>> | undefined,
): boolean {
  if (!providerOptions) return false;
  const { anthropic, openai } = providerOptions;
  if (anthropic?.signature != null || anthropic?.redactedData != null) return true;
  return openai?.itemId != null;
}

/**
 * Drop non-replayable `reasoning` parts from an assistant message (see
 * {@link isReplayableReasoning}). Reasoning that a provider still needs is kept
 * so multi-turn tool calls survive on the OpenAI Responses API and Anthropic
 * extended thinking. Returns `null` if the message had nothing left to keep.
 */
function withoutReasoning(m: ModelMessage): ModelMessage | null {
  if (m.role !== "assistant" || typeof m.content === "string") return m;
  const content = m.content.filter(
    (part) => part.type !== "reasoning" || isReplayableReasoning(part.providerOptions),
  );
  if (content.length === 0) return null;
  return { ...m, content };
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
      for (const m of msgs) {
        const cleaned = withoutReasoning(m);
        if (cleaned) llm.push(cleaned);
      }
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
