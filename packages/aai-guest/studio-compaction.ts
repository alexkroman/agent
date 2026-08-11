// Copyright 2026 the AAI authors. MIT license.
/**
 * Keeping a long turn inside the context window, so the step budget can be
 * generous.
 *
 * Measured across the starter evals, the dominant failure was not a wrong
 * design — it was running out of steps mid-repair: build, read the error,
 * edit, build again, and the turn dies at the cap with a broken workspace.
 * opencode does not hit this because it allows ~1000 steps and summarizes
 * when usage approaches the model's limit; we hard-stopped at 16 instead.
 *
 * Raising the cap alone would just trade a step-cap failure for a
 * context-overflow one, because the bulky messages in a build loop are tool
 * RESULTS — a tsc diagnostic dump or a build log, repeated once per attempt.
 * So the two changes belong together: a higher ceiling, and compaction to
 * make it reachable.
 *
 * What is preserved matters as much as what is dropped:
 *
 * - **The first user message is never compacted.** It is the actual request,
 *   and an agent that forgets it half way through a repair loop starts
 *   building something else.
 * - **The most recent messages are never compacted.** They are the error
 *   being fixed right now.
 * - Only the middle is summarized, and the summary is generated once per
 *   compaction rather than per step.
 */

import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { studioGenerationTelemetry } from "./studio-generation-telemetry.ts";

/**
 * Rough token estimate. Deliberately a heuristic: the exact count depends on
 * the tokenizer, and being approximately right one step early is fine when
 * the alternative is a hard context error.
 */
export function estimateTokens(messages: readonly ModelMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
  }
  return Math.ceil(chars / 4);
}

export type CompactionOptions = {
  /** Compact once the estimate exceeds this. */
  budgetTokens: number;
  /** Recent messages kept verbatim — the work in progress. */
  keepRecent: number;
  /** Leading messages kept verbatim — the request itself. */
  keepLeading: number;
};

export const DEFAULT_COMPACTION: CompactionOptions = {
  // Conservative against the smallest gateway context we might run on;
  // compacting early costs one cheap call, compacting late costs the turn.
  budgetTokens: 60_000,
  keepRecent: 8,
  keepLeading: 1,
};

/** Would this message list be compacted? Exposed for tests and logging. */
export function needsCompaction(
  messages: readonly ModelMessage[],
  opts: CompactionOptions = DEFAULT_COMPACTION,
): boolean {
  return (
    estimateTokens(messages) > opts.budgetTokens &&
    messages.length > opts.keepLeading + opts.keepRecent + 1
  );
}

/** Plain text of a message, for the summarizer's input. */
function flatten(m: ModelMessage): string {
  if (typeof m.content === "string") return `${m.role}: ${m.content}`;
  const parts = (m.content as { type?: string; text?: string }[])
    .map((p) => (typeof p.text === "string" ? p.text : `[${p.type ?? "part"}]`))
    .join(" ");
  return `${m.role}: ${parts}`;
}

/**
 * Replace the middle of the conversation with a summary.
 *
 * Returns the original array unchanged when compaction is unnecessary or the
 * summary call fails — losing the middle to a failed summarizer would be
 * worse than a long context.
 */
export async function compactMessages(
  model: LanguageModel,
  messages: readonly ModelMessage[],
  opts: CompactionOptions = DEFAULT_COMPACTION,
): Promise<ModelMessage[]> {
  if (!needsCompaction(messages, opts)) return [...messages];

  const leading = messages.slice(0, opts.keepLeading);
  const recent = messages.slice(-opts.keepRecent);
  const middle = messages.slice(opts.keepLeading, messages.length - opts.keepRecent);
  if (middle.length === 0) return [...messages];

  try {
    const { text } = await generateText({
      model,
      ...studioGenerationTelemetry("studio-compaction"),
      prompt: [
        "Summarize this portion of a coding session so the agent can continue",
        "without re-reading it. Be specific and factual — keep file names, the",
        "decisions already made, what has been built, and any error that is",
        "still outstanding. Drop tool output that no longer matters. Do not",
        "invent progress that is not described.",
        "",
        middle.map(flatten).join("\n").slice(0, 40_000),
      ].join("\n"),
    });
    const summary: ModelMessage = {
      role: "user",
      content: `[Earlier in this session, summarized to save context]\n${text}`,
    };
    return [...leading, summary, ...recent];
  } catch {
    // A failed summary must not drop the middle.
    return [...messages];
  }
}
