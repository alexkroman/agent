// Copyright 2026 the AAI authors. MIT license.
/**
 * A run's `label` (`StartOptions.label`): the one normalization every writer
 * applies before it reaches a journal.
 *
 * Its own module because it has TWO callers on opposite sides of a trust
 * boundary, and they must agree: `workflow/client.ts` normalizes what a tool
 * passed to `ctx.workflows.start`, and the platform's guest journal handler
 * (`aai-server/guest-handlers/workflow-journal.ts`) applies it again to what a
 * guest SENDS, because a guest is untrusted and could send anything as
 * `label`. One function, imported by both, is what keeps "what a label may be"
 * a single statement rather than two that drift.
 *
 * The rule is NORMALIZE, never refuse — a label is a courtesy to whoever reads
 * a run list, and failing a `start` over one would lose the work it describes:
 *
 * - **Control characters become spaces.** A label is rendered in a page, a CLI
 *   table and a log line; a newline there forges a second row and an escape
 *   sequence repaints a terminal.
 * - **Trimmed, then cut at {@link MAX_WORKFLOW_RUN_LABEL_CHARS} CODE POINTS**,
 *   not UTF-16 units, so a cut never leaves half a surrogate pair — an
 *   unpaired surrogate is not valid UTF-8 and would fail the insert on a
 *   Postgres `text` column rather than merely look odd.
 * - **Empty after that means NO label**, so a whitespace-only value does not
 *   become a blank that every reader has to special-case against an absent one.
 */

/**
 * The longest `StartOptions.label` a run keeps, in code points; a longer one is
 * cut.
 *
 * 200: a label is one line in a list ("call the plumber, due 5 PM"), and the
 * app this replaced capped its own column at 300 with every real value far
 * under 100. Small enough that a listing of `MAX_WORKFLOW_FIND_LIMIT` runs
 * stays a small response; large enough that no honest label is cut.
 */
export const MAX_WORKFLOW_RUN_LABEL_CHARS = 200;

/**
 * The label a run is stored with, or `undefined` for none — see the module doc
 * for each rule. Accepts `unknown` because the platform half reads it off a
 * request body, where a non-string is simply no label.
 */
export function normalizeRunLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cut = Array.from(value.replace(/\p{Cc}/gu, " ").trim())
    .slice(0, MAX_WORKFLOW_RUN_LABEL_CHARS)
    .join("")
    .trimEnd();
  return cut === "" ? undefined : cut;
}
