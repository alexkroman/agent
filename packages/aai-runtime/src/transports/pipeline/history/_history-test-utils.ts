// Copyright 2026 the AAI authors. MIT license.
/**
 * The fixtures `history.test.ts` and `history-retention.test.ts`
 * share: a small retention bound, token totals in the history's own units, and
 * tool-call/result messages with an orphan detector.
 */

import type { Message } from "@alexkroman1/aai";
import type { ModelMessage } from "ai";
import { estimateMessageTokens } from "./context-budget.ts";
import { estimateConversationTokens } from "./retention.ts";

/**
 * A small memory bound, so a spec reaches it in tens of messages rather than
 * megabytes. The default (`HISTORY_RETAIN_TOKENS`) is sized against the largest
 * request budget, and `history-retention.test.ts` holds why it cannot reach
 * into a request; what is pinned HERE is the history's own use of the bound.
 */
export const RETAIN = 600;
export const textTokens = (ms: readonly Message[]): number =>
  ms.reduce((n, m) => n + estimateConversationTokens(m), 0);
export const llmTokens = (ms: readonly ModelMessage[]): number =>
  ms.reduce((n, m) => n + estimateMessageTokens(m), 0);
/** A rolled-back prompt long enough that its push always evicts something. */
export const LONG_PROMPT = `RESUME_PROMPT ${"please continue where you left off ".repeat(8)}`;

/** Tool-call ids that appear as a result with no preceding call. */
export function orphanToolResults(llm: readonly ModelMessage[]): string[] {
  const called = new Set<string>();
  const orphans: string[] = [];
  for (const m of llm) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as { type?: string; toolCallId?: string }[]) {
      if (part.type === "tool-call" && part.toolCallId !== undefined) called.add(part.toolCallId);
      if (
        part.type === "tool-result" &&
        part.toolCallId !== undefined &&
        !called.has(part.toolCallId)
      ) {
        orphans.push(part.toolCallId);
      }
    }
  }
  return orphans;
}

export const toolCallMsg = (id: string): ModelMessage =>
  ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "lookup", input: {} }],
  }) as ModelMessage;

export const toolResultMsg = (id: string): ModelMessage =>
  ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "lookup",
        output: { type: "text", value: "ok" },
      },
    ],
  }) as ModelMessage;
