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
 *
 * ## Two tiers, and the cheap one is aimed at the bulk this file names
 *
 * The paragraph above identifies the bulk precisely — tool RESULTS, one per
 * build attempt — and the original implementation reached straight for a
 * summarizer anyway, paying an LLM call to compress text whose location was
 * already known. {@link pruneMessages} drops exactly those: tool-call and
 * tool-result content older than the recent window, removed in PAIRS by
 * `toolCallId` so nothing is orphaned, with any pair whose result is still in
 * the window kept whole. It is deterministic, free, and cannot fail.
 *
 * So it runs first, and the summarizer runs only if the estimate is still over
 * budget afterwards — which is the case the summarizer was really for, a long
 * conversation rather than a bulky one.
 *
 * ## A cut point has to fall on a turn boundary
 *
 * Tier 2 splices `[...leading, summary, ...recent]`, and both cuts land in the
 * middle of a conversation whose shape is assistant(tool-call) / tool(result),
 * alternating, for the length of a repair loop. A `recent` window that BEGINS
 * on a tool message therefore emits a tool result whose tool-call went into the
 * summary — and both providers reject an unmatched tool result outright
 * ("messages with role 'tool' must be a response to a preceding message with
 * 'tool_calls'"), so the turn dies at the provider with every step of the
 * repair loop still to run. This is the same failure `capLlm` documents in
 * `aai/host/transports/pipeline-history.ts`, arriving by a different route: an
 * index-based trim drifts out of alignment with turn boundaries on its own,
 * because turns are not a uniform number of messages.
 *
 * One check covers both cuts, and it is worth seeing why: a cut at index `i` is
 * safe iff `messages[i]` is not a `tool` message. An assistant message carrying
 * tool-calls is always followed immediately by its results, so "the message
 * after the cut is not a result" also establishes "the message before the cut
 * is not an unanswered call" — the mirror-image error, which providers reject
 * just as hard. {@link turnBoundary} is that check; both boundaries move
 * OUTWARD from the middle, so an adjustment only ever keeps more verbatim.
 */

import { generateText, type LanguageModel, type ModelMessage, pruneMessages } from "ai";

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

/**
 * Would this message list be compacted? Exposed for tests and logging.
 *
 * `estimate` is threaded rather than recomputed because {@link estimateTokens}
 * stringifies every non-string message content and the list it walks is the
 * WHOLE conversation — measured at roughly 240 KB of `JSON.stringify` per pass
 * in a long repair loop. The caller in `studio-chat.ts` asks this question and
 * then hands the same list to {@link compactMessages}, which asked it again:
 * three full passes per STEP, two of them over identical input.
 */
export function needsCompaction(
  messages: readonly ModelMessage[],
  opts: CompactionOptions = DEFAULT_COMPACTION,
  estimate: number = estimateTokens(messages),
): boolean {
  return estimate > opts.budgetTokens && messages.length > opts.keepLeading + opts.keepRecent + 1;
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
 * Move a cut index off a tool result, in the given direction.
 *
 * `step` is +1 for the leading boundary (grow `leading`, so the first user
 * message is never the thing given up) and -1 for the recent boundary (grow
 * `recent`, so the in-progress error is never the thing given up). Both
 * directions shrink the summarized middle, which is always safe.
 */
function turnBoundary(messages: readonly ModelMessage[], index: number, step: 1 | -1): number {
  let i = index;
  while (i > 0 && i < messages.length && messages[i]?.role === "tool") i += step;
  return i;
}

/**
 * Bring a long conversation back under budget: prune stale tool payloads, and
 * summarize the middle if that was not enough.
 *
 * Returns the messages unchanged when compaction is unnecessary or the summary
 * call fails — losing the middle to a failed summarizer would be worse than a
 * long context.
 *
 * `estimate` is the caller's already-computed token estimate for `messages`;
 * see {@link needsCompaction}. The check AFTER tier 1 re-estimates on purpose —
 * it is a different list, and its whole job is to find out how much tier 1 took
 * off.
 */
export async function compactMessages(
  model: LanguageModel,
  messages: readonly ModelMessage[],
  opts: CompactionOptions = DEFAULT_COMPACTION,
  estimate: number = estimateTokens(messages),
): Promise<ModelMessage[]> {
  if (!needsCompaction(messages, opts, estimate)) return [...messages];

  // Tier 1: drop the tool call/result payloads older than the recent window —
  // the tsc dumps and build logs this loop accumulates. Deterministic, free,
  // and pair-safe; most turns need nothing further.
  const pruned = pruneMessages({
    messages: [...messages],
    toolCalls: `before-last-${opts.keepRecent}-messages`,
  });
  if (!needsCompaction(pruned, opts)) return pruned;

  // Tier 2: summarize what is left of the middle. Both cuts are moved off a
  // tool result first — see `turnBoundary`.
  const lead = turnBoundary(pruned, Math.min(opts.keepLeading, pruned.length), 1);
  const start = turnBoundary(pruned, Math.max(lead, pruned.length - opts.keepRecent), -1);
  const leading = pruned.slice(0, lead);
  const middle = pruned.slice(lead, start);
  const recent = pruned.slice(start);
  if (middle.length === 0) return pruned;

  try {
    const { text } = await generateText({
      model,
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
    // A failed summary must not drop the middle. Tier 1's result still stands:
    // it removed nothing the model needs to stay coherent, and returning the
    // un-pruned list would throw away the only progress this call made.
    return pruned;
  }
}
