// Copyright 2026 the AAI authors. MIT license.
/**
 * Rendering the digest into the fast tier's prompt — the "zero extra model
 * calls" half of TalkAct's contract, made literal.
 *
 * The fast tier consumes the digest by finding it in the system prompt of the
 * request it was already going to make. There is no second model call, no
 * summarization pass, and no round trip: a turn on which nothing happened
 * costs exactly what it cost before, plus this string.
 *
 * **A SUFFIX rather than a rebuilt prompt**, through the seam
 * `runtime-system-prompt.ts` already built for `dialog()` — and it is the same
 * argument, stated there: "the only way a phase reaches the model today is a
 * tool RESULT, so on a turn where no tool ran, the agent answers with no idea
 * where in the script it is." Replace "phase" with "whether the work is
 * finished" and that sentence IS the hallucinated-completion failure. A tool
 * result alone cannot fix it, because the turn where the caller asks "so it's
 * all set?" is precisely a turn on which no tool ran.
 *
 * Nothing here calls a model or reads a clock.
 */

import { MAX_STATE_DIGEST_CHARS } from "@alexkroman1/aai";
import type { DigestEntry, StateDigest, WorkState } from "./digest.ts";

/**
 * How each state is described to the fast tier.
 *
 * Wording rule for this table and for every prompt string in this directory:
 * **could this sentence appear in a call-center training manual written before
 * its author ever saw a benchmark?** (Pickle's litmus test, from
 * `mentor-prompt-constitution.md`.) So: no tool names, no domain entities, no
 * task families, no benchmark vocabulary — procedures only, over runtime
 * state. A sentence that fails the test smuggles information past the runtime
 * boundary {@link SlowTierView} exists to enforce, and a gate that scores well
 * because of one has measured nothing that can ship.
 */
const STATE_WORDING = {
  pending: "IN PROGRESS — not finished, do not describe it as done",
  done: "completed and confirmed",
  refused: "NOT done — it was declined",
  unverified: "carried out, but not confirmed",
  failed: "NOT done — it failed",
} as const satisfies Record<WorkState, string>;

/**
 * The heading the section renders under.
 *
 * Exported because the specs assert on the section's PRESENCE and a second
 * spelling is how a rendering test comes to pass against a prompt nobody is
 * sending.
 */
export const DIGEST_HEADING = "## WORK STATUS";

const NO_CLAIM_RULE =
  "State only what this status says. If anything above is in progress, say so plainly and " +
  "do not tell the caller it is finished. Do not describe work as complete unless this status " +
  "says it completed.";

function renderEntry(entry: DigestEntry): string {
  const wording = STATE_WORDING[entry.state];
  const note = entry.note === "" ? "" : ` (${entry.note})`;
  return `- ${entry.tool}: ${wording}${note}`;
}

/**
 * Render one session's digest as a system-prompt section, or `""` when there is
 * nothing to say.
 *
 * **The empty answer is load-bearing.** `SessionSystemPrompt.resolve` returns
 * the base prompt ITSELF for an empty suffix, so an agent with `twoTier`
 * declared but no work yet proposed sends exactly the bytes it sent before this
 * feature existed — which is what makes the off-arm and the on-arm-before-first-
 * tool-call comparable at all.
 *
 * The cap trims the oldest SETTLED entries first and keeps every unsettled one:
 * what is pending is the half the section exists to state, and a truncation
 * that dropped it would silently disable the gate's grounding on the longest
 * calls.
 */
export function renderDigestSection(digest: StateDigest): string {
  const { summary, entries } = digest;
  if (summary === "" && entries.length === 0) return "";

  const pending = entries.filter((e) => e.state === "pending");
  const settled = entries.filter((e) => e.state !== "pending");

  const lines: string[] = [DIGEST_HEADING];
  if (summary !== "") lines.push(summary);
  // Pending first, and not merely for emphasis: it is what survives the cap.
  for (const entry of pending) lines.push(renderEntry(entry));
  for (const entry of settled) lines.push(renderEntry(entry));
  lines.push(NO_CLAIM_RULE);

  const text = lines.join("\n");
  if (text.length <= MAX_STATE_DIGEST_CHARS) return text;

  // Over budget: drop settled entries from the OLDEST end until it fits. The
  // heading, the summary, every pending entry and the rule are kept — if even
  // those overrun, the summary is what gets cut, because it is the one part the
  // slow tier can restate on its next verdict.
  const keep = [...settled];
  while (keep.length > 0) {
    keep.shift();
    const retry = [
      DIGEST_HEADING,
      ...(summary === "" ? [] : [summary]),
      ...pending.map(renderEntry),
      ...keep.map(renderEntry),
      NO_CLAIM_RULE,
    ].join("\n");
    if (retry.length <= MAX_STATE_DIGEST_CHARS) return retry;
  }
  return [DIGEST_HEADING, ...pending.map(renderEntry), NO_CLAIM_RULE]
    .join("\n")
    .slice(0, MAX_STATE_DIGEST_CHARS);
}
