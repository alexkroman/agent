// Copyright 2026 the AAI authors. MIT license.
/**
 * Calling a subagent's guardrail the way the runtime does — from a spec.
 *
 * A `SubagentDef.guardrail` is the one piece of a subagent a spec can test
 * without a model: it is a pure function of an answer. What two templates each
 * wrote to call it was the same seven lines — build a `SubagentAnswer` around
 * a text with a zero cost report, reach `def.guardrail`, throw if the def has
 * none, throw if the verdict came back as a promise — and the last of those is
 * the reason this is a helper rather than a one-liner: `SubagentGuardrail` may
 * return a `Promise<GuardrailVerdict>`, so a spec that read the verdict
 * directly compiled against `true | string | Promise<…>` and could not assert
 * on it without a cast or a check it had to remember.
 *
 * @module testing-guardrail
 */

import type { GuardrailVerdict, SubagentAnswer, SubagentDef } from "./subagent.ts";

/**
 * Run `def`'s guardrail over one answer and return its verdict.
 *
 * The answer is `text` with a ZERO cost report — one step, no tool calls —
 * because that is what most guardrails read; a guardrail that judges the cost
 * (`toolCalls.length === 0`, say) is handed it through `answer`, which is
 * spread over the defaults.
 *
 * **Throws when the def declares no guardrail**, rather than returning `true`:
 * a spec calling this is asserting that a check exists, and a def that lost its
 * guardrail should fail here, not pass by default. **Throws when the guardrail
 * returns a promise**: this helper is for the SYNCHRONOUS guardrail, which is
 * the ordinary one, and an async guardrail's spec awaits `def.guardrail(answer)`
 * itself — the verdict is then a promise a test can `await`, and nothing here
 * would add to that.
 *
 * @example
 * ```ts
 * import { subagent } from "@alexkroman1/aai";
 * import { runGuardrail } from "@alexkroman1/aai/testing";
 *
 * const checker = subagent({
 *   name: "fact-checker",
 *   systemPrompt: "Open with Confirmed:, Contradicted: or Unclear:.",
 *   guardrail: ({ text }) => /^(Confirmed|Contradicted|Unclear):/.test(text) || "Open with a verdict word.",
 * });
 *
 * runGuardrail(checker, "Confirmed: the figure is 12%."); // true
 * runGuardrail(checker, "It seems prices fell."); // "Open with a verdict word."
 * ```
 *
 * @public
 */
export function runGuardrail(
  def: SubagentDef,
  text: string,
  answer: Partial<SubagentAnswer> = {},
): GuardrailVerdict {
  const guardrail = def.guardrail;
  if (guardrail === undefined) {
    throw new Error(`runGuardrail: subagent "${def.name}" declares no guardrail.`);
  }
  const verdict = guardrail({ text, steps: 1, toolCalls: [], ...answer });
  // `true | string | Promise<…>` — only the promise is an object.
  if (typeof verdict === "object") {
    throw new Error(
      `runGuardrail: the guardrail on subagent "${def.name}" returned a promise — this helper is for a synchronous guardrail. Await def.guardrail(answer) directly for an async one.`,
    );
  }
  return verdict;
}
