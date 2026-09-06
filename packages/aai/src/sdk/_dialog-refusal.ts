// Copyright 2026 the AAI authors. MIT license.
/**
 * The sentence a `dialog()` gate refuses with, owned in ONE place.
 *
 * `dialog.ts` WRITES it, once per out-of-state call, and `@alexkroman1/aai/testing`
 * MATCHES it, in every spec that asserts a gate held. Those used to be two
 * files with no import between them: the writer was a template literal in the
 * gate and the matchers were regexes in seven templates' specs, two of them
 * re-deriving the JSON-escaping an eval reads the sentence through. Rewording
 * the refusal — which is the model-facing half of the gate, and the thing an
 * author would most want to tune — would have broken eight suites that never
 * imported it.
 *
 * So the template lives here, and the pattern is DERIVED from it: a spec that
 * asks {@link dialogRefusalPattern} can only ever disagree with the gate about
 * a sentence that was never written.
 *
 * @module _dialog-refusal
 */

/**
 * How every refusal opens. The state follows in quotes, then the instruction
 * the current state carries (or the states the tool would have accepted).
 */
const REFUSAL_PREFIX = "Not available yet: this conversation is at";

/** The refusal for a tool called at `state`, followed by what has to happen first. */
export function dialogRefusalMessage(state: string, expectation: string): string {
  return `${REFUSAL_PREFIX} "${state}". ${expectation}`;
}

/**
 * A pattern matching the sentence a `dialog()` gate refuses with — optionally
 * pinned to the state it names.
 *
 * For a SPEC. A gated tool called out of state answers a `ToolFailure` whose
 * `error` is this sentence, and every template spec that asserts a gate held
 * used to spell a regex for it by hand. Two kinds of spec read it, and the
 * pattern serves both: a unit test holds the `ToolFailure` itself (prefer
 * `expectDialogRefused` there, which also throws on a success), while an eval
 * reads a tool result off the event stream as a SERIALIZED string, where the
 * state's quotes arrive escaped (`\"identifying\"`). The pattern admits the
 * escaping, so one matcher reads both.
 *
 * With no `state`, it matches any refusal — for a spec that pins the state a
 * line later, or whose subject is that the body did not run rather than where
 * the conversation was.
 *
 * @param state - The state the refusal must name, as `DialogPosition.state`
 *   spells it (`"identifying"`, `"onCall.inbox"`). Matched literally.
 *
 * @example
 * ```ts
 * import { dialogRefusalPattern } from "@alexkroman1/aai/testing";
 *
 * const refused = 'Not available yet: this conversation is at "identifying". Verify the caller first.';
 * dialogRefusalPattern("identifying").test(refused); // true
 * dialogRefusalPattern("transferred").test(refused); // false
 * dialogRefusalPattern().test(refused); // true
 * ```
 *
 * @public
 */
export function dialogRefusalPattern(state?: string): RegExp {
  const head = escapeRegExp(REFUSAL_PREFIX);
  if (state === undefined) return new RegExp(head);
  // `\\?"` on both sides: the same sentence, as JSON.stringify leaves it when a
  // tool result crosses the event stream as a string.
  return new RegExp(`${head} \\\\?"${escapeRegExp(state)}\\\\?"`);
}

/** Every character `RegExp` reads as syntax, quoted. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
