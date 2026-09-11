// Copyright 2026 the AAI authors. MIT license.
/**
 * Regex-keyed endpointing overrides — the HIGHEST-priority layer of the
 * end-of-turn decision.
 *
 * `DEFAULT_MIN_TURN_SILENCE_MS` (1600) is right on AVERAGE and wrong on
 * numbers. The measurement behind it (see `endpointing-constants.ts`) is a
 * whole-corpus knee: below it a spelled identifier splits, above it every
 * finished utterance pays. Both halves of that are content-dependent — the
 * caller reading out an order id pauses between chunks, and the caller
 * answering a yes/no question does not — so one number cannot be right for
 * both and the corpus average is the best a single number can do.
 *
 * A rule table keys the wait to CONTENT: what the agent last said, what the
 * caller is saying right now, or both. Copied deliberately from Vapi's
 * `AssistantCustomEndpointingRule` / `CustomerCustomEndpointingRule` /
 * `BothCustomEndpointingRule` (https://api.vapi.ai/api-json) — the shape is
 * theirs, the numbers are ours, because our baseline is 1600 and theirs is not.
 *
 * ## Four properties of the table
 *
 * - **First match wins**, in declaration order. Not "longest match", not "most
 *   specific": an author reads the list top to bottom and a rule they can see
 *   above another one is the one that fires. Put the narrow rules first.
 * - **A match REPLACES the wait**, it does not add to it. The value is the
 *   whole endpointing window, so a rule can shorten as well as lengthen.
 * - **Matching is `RegExp.test`, so it is SUBSTRING matching.** `"order"`
 *   matches "your order number" AND "reorder". This trips people up, so it is
 *   stated on the type as well as here: anchor with `^`/`$` or `\b` when you
 *   mean the whole thing.
 * - **The pattern is a STRING, not a `RegExp`.** An agent definition is
 *   serialized (CLI → platform → guest) and a `RegExp` does not survive
 *   `JSON.stringify`. Same choice Vapi's JSON API makes, and the reason
 *   `flags` is a separate field.
 *
 * ## What the ceiling is, and why it is not Vapi's 15s
 *
 * Vapi caps a rule at 15 seconds. {@link MAX_ENDPOINTING_RULE_TIMEOUT_MS} is
 * **5000**, and the argument is structural rather than a preference: the wait
 * is served by the STT's own `min_turn_silence`, which must stay at or below
 * `max_turn_silence` (3500 by default) — inverting that pair is the measured
 * regression `DEFAULT_MIN_TURN_SILENCE_MS` documents, where every turn ending
 * came from the acoustic fallback that splits utterances. And
 * `max_turn_silence` itself is held below `DEFAULT_SPEECH_IDLE_TIMEOUT_MS`
 * (4000) less final-emission latency, because the speaking edge going idle is
 * what fires a false-interruption resume: cross that line and the agent
 * resumes a reply over a caller who is still mid-sentence.
 *
 * So 5000 is the DECLARATION cap — it catches `timeoutMs: 60000` at
 * `agent()` rather than at a call — and the effective value is clamped AGAIN
 * at application time to the session's own `maxTurnSilenceMs`
 * (`clampEndpointingTimeout`). A rule can therefore never invert the pair,
 * whatever it declares.
 *
 * @module
 */

/**
 * Longest wait a single endpointing rule may declare, in ms.
 *
 * See the module doc: Vapi's equivalent cap is 15s, this one is 5s, and the
 * effective value is clamped a second time against the session's own
 * `maxTurnSilenceMs` — a rule may not put the STT's floor above its ceiling.
 *
 * @internal
 */
export const MAX_ENDPOINTING_RULE_TIMEOUT_MS = 5000;

/** Fields every endpointing rule carries. @public */
export interface EndpointingRuleBase {
  /**
   * The end-of-turn silence window to use while this rule matches, in ms —
   * REPLACING the agent's own endpointing value rather than adding to it.
   *
   * Clamped to `MAX_ENDPOINTING_RULE_TIMEOUT_MS` (5000) at declaration, and
   * again to the session's `maxTurnSilenceMs` when it is applied. (Named
   * rather than `{@link}`ed: that constant is `@internal`, so a link to it
   * from this public interface is a docs-build error.)
   */
  timeoutMs: number;
  /**
   * `RegExp` flags for this rule's pattern(s).
   *
   * @defaultValue `"i"` — a transcript's casing is the ASR's choice, not the
   * caller's, so a case-sensitive pattern is almost always a bug here. Pass
   * `""` for case-sensitive matching.
   */
  flags?: string | undefined;
}

/**
 * Match on the AGENT's last message.
 *
 * The use: the agent just asked for something that is READ OUT — an order id,
 * an email, a postcode — so the caller will pause between chunks and the
 * default window ends their turn mid-identifier. Or the inverse: the agent
 * asked a yes/no question, the answer is one word, and waiting 1600ms for more
 * of it is dead air.
 *
 * @public
 */
export interface AssistantEndpointingRule extends EndpointingRuleBase {
  type: "assistant";
  /** Tested against the agent's last message. SUBSTRING semantics — see the module doc. */
  regex: string;
}

/**
 * Match on the caller's IN-FLIGHT transcript — the interim, not the committed
 * final, because the point is to decide how long to wait before it becomes
 * one.
 *
 * The use: a transcript that currently ends in digits is a caller part-way
 * through reading a number, and the gap between "one nine one" and "two two"
 * is not the end of their turn.
 *
 * @public
 */
export interface UserEndpointingRule extends EndpointingRuleBase {
  type: "user";
  /** Tested against the in-flight user transcript. SUBSTRING semantics. */
  regex: string;
}

/** Both sides must match. @public */
export interface BothEndpointingRule extends EndpointingRuleBase {
  type: "both";
  /** Tested against the agent's last message. */
  assistantRegex: string;
  /** Tested against the in-flight user transcript. */
  userRegex: string;
}

/**
 * One entry in {@link PipelineVoiceTuning.endpointingRules}.
 *
 * @public
 */
export type EndpointingRule = AssistantEndpointingRule | UserEndpointingRule | BothEndpointingRule;

/** What {@link matchEndpointingRule} answers. @internal */
export interface EndpointingRuleMatch {
  /** Position of the matching rule in the declared list. */
  index: number;
  /** The rule's declared wait, already clamped to the declaration cap. */
  timeoutMs: number;
}

/** The two strings a rule is evaluated against. @internal */
export interface EndpointingInput {
  /** The agent's last message, or `undefined` before it has said anything. */
  assistantMessage?: string | undefined;
  /** The caller's in-flight transcript; `""` between utterances. */
  userTranscript?: string | undefined;
}

/**
 * Compiled patterns, keyed by the rule OBJECT.
 *
 * A rule list is declared once per agent and evaluated once per STT partial
 * (~5/s while the caller talks), so compiling on every read would be a
 * `new RegExp` per pattern per partial for the length of the call. Keyed on
 * the object rather than on the source so two rules with the same pattern and
 * different flags cannot collide, and weak so a per-session list is collected
 * with the session.
 */
const compiled = new WeakMap<EndpointingRule, readonly (RegExp | null)[]>();

/** The pattern(s) a rule tests, in the order {@link ruleMatches} applies them. */
function patternsOf(rule: EndpointingRule): readonly string[] {
  return rule.type === "both" ? [rule.assistantRegex, rule.userRegex] : [rule.regex];
}

/**
 * Compile a rule's patterns, caching per rule object.
 *
 * A pattern that will not compile yields `null` and the rule never matches —
 * it does NOT throw. This runs inside the STT partial handler, where a throw
 * escapes into a provider callback; the declaration-time gate
 * (`assertEndpointingRules`) is where a bad pattern is reported, and this is
 * the backstop for a config that reached the runtime some other way.
 */
function compileRule(rule: EndpointingRule): readonly (RegExp | null)[] {
  const cachedRule = compiled.get(rule);
  if (cachedRule !== undefined) return cachedRule;
  const flags = rule.flags ?? "i";
  const built = patternsOf(rule).map((source) => {
    try {
      return new RegExp(source, flags);
    } catch {
      return null;
    }
  });
  compiled.set(rule, built);
  return built;
}

/** Does `rule` match this input? */
function ruleMatches(rule: EndpointingRule, input: EndpointingInput): boolean {
  const patterns = compileRule(rule);
  const assistant = input.assistantMessage ?? "";
  const user = input.userTranscript ?? "";
  if (rule.type === "assistant") return patterns[0]?.test(assistant) ?? false;
  if (rule.type === "user") return patterns[0]?.test(user) ?? false;
  // "both" is an AND over two independent patterns, so a missing side is a
  // non-match rather than a vacuous truth.
  return (patterns[0]?.test(assistant) ?? false) && (patterns[1]?.test(user) ?? false);
}

/**
 * The FIRST rule that matches, or `undefined`.
 *
 * Declaration order, first match wins — see the module doc for why that rather
 * than a specificity ranking.
 *
 * @internal
 */
export function matchEndpointingRule(
  rules: readonly EndpointingRule[],
  input: EndpointingInput,
): EndpointingRuleMatch | undefined {
  for (const [index, rule] of rules.entries()) {
    if (!ruleMatches(rule, input)) continue;
    return { index, timeoutMs: Math.min(rule.timeoutMs, MAX_ENDPOINTING_RULE_TIMEOUT_MS) };
  }
  return undefined;
}

/**
 * The wait a matched rule may actually be given, on a session whose STT
 * ceiling is `maxTurnSilenceMs`.
 *
 * The floor of 1 is not defensive: `min_turn_silence: 0` means "use the
 * service default" on the wire, which is the one value that must not be
 * reachable from a rule — it would silently hand the window back to the
 * provider's `mode` preset.
 *
 * @internal
 */
export function clampEndpointingTimeout(timeoutMs: number, maxTurnSilenceMs: number): number {
  return Math.max(1, Math.min(Math.round(timeoutMs), maxTurnSilenceMs));
}

/**
 * The shipped rule set for a retail-shaped voice line.
 *
 * **Every number is relative to the measured 1600ms baseline**
 * (`DEFAULT_MIN_TURN_SILENCE_MS`), not to Vapi's. Vapi's own heuristic
 * defaults are number-final 0.5s, punctuation 0.1s and no-punctuation 1.5s
 * against an unstated baseline; scaled onto ours, "wait longer for a number"
 * is the same SHAPE and a very different value, because 500ms would split a
 * spelled identifier on this corpus and 1600 already nearly does.
 *
 * | Rule | Wait | Where the number comes from |
 * | --- | --- | --- |
 * | caller is SPELLING (3+ single letters in a row) | **3000** | The one shape a global threshold is certain to cut: a letter-by-letter sequence has the longest inter-letter pauses of anything a caller says, and it happens precisely when the agent has already mis-heard them once ("S-O-F-I-A, last name Lee, L-I", measured). 3000 leaves 500ms under the 3500 ceiling, so a hesitant utterance is still force-ended by `max_turn_silence` rather than by nothing. |
 * | agent asked WHO the caller is | **3000** | **The most load-bearing rule in the table on this corpus.** Over 9 tau2-bench retail simulations on 3 hard cases, digit strings were already fine at 1600 — 41 order-id renderings, one digit substitution, never reaching a tool — while names collapsed: "Yusuf" → "Yuta" → "Yufus" (three failed lookups, then escalation), "Sofia Li" → "Sophia Lee". A name has no checksum, so one mis-heard syllable is a failed lookup rather than a retry. Same 3000 as the spelling rule, because the caller's response to a failed lookup IS to spell. |
 * | agent asked for a read-out identifier | **2600** | The measured worst-case intra-utterance pause while a caller spells a name is **1455ms** (`DEFAULT_MIN_TURN_SILENCE_MS`'s 18-pause instrumentation), and nine of those eighteen pauses cleared 1000. 1600 clears the observed worst case by 145ms, which is thin, and the failure it buys is the expensive one (a truncated auth argument, reward 1.00 → 0.40). 2600 clears it by ~1.1s and stays under the 3500 ceiling, so a hesitant utterance is still force-ended by `max_turn_silence` rather than by this. |
 * | caller's transcript ends in a digit | **2600** | Same window, keyed the other way, and the two are deliberately equal: a caller mid-number is mid-number whether or not the agent's question is what put them there ("it's one nine one two…" volunteered). The pause distribution is the same distribution. |
 * | agent asked a closed yes/no question | **900** | The answer is one word, so nothing is waiting to be merged, and the whole 1600 is dead air the caller hears as the agent being slow. 900 is deliberately NOT lower: the measured floor on this pipeline is ~470ms to a first partial (a MODEL floor — `interruption_delay` and `mode` are no-ops), so a window under ~700ms is decided before the second word of a two-word answer ("yes please", "no thanks") could arrive. |
 *
 * **This set is UNMEASURED as a set, and the instrument cannot settle it
 * either.** Each number is derived from a measurement above, but no run has
 * scored the table — and the gate runs n=3 per case, at which identical code
 * flips at least one of the three about half the time, so a reward delta from
 * it would be noise (`project_voice_benchmark_noise_floors`: 0.56/0.60 on
 * identical code, 9 of 25 tasks flipping). What CAN be read off a run at that
 * sample size is the entity-level count the numbers are argued from — how
 * often a name reached a tool call intact, and the split/merge cardinality
 * from tau2-bench's own `scripts/stt_errors.py`. Judge a change to this table
 * on those, not on reward. Pass `endpointingRules: []` to disable it.
 *
 * @internal
 */
/**
 * The things a caller READS OUT, as an alternation.
 *
 * COMPOSED from a list rather than written as one literal, for the reason
 * `workflow/uploads.ts` and `eval/run-code.ts` compose theirs: biome's
 * `noSecrets` reads a long punctuation-dense string as a high-entropy secret.
 * It happens to read better too — each entry is one thing an agent asks for.
 */
/**
 * A caller SPELLING, in progress — two arms, and the split is the whole
 * design.
 *
 * Explicit spelling PUNCTUATION ("S-O-F-I-A", "s. o. f.") takes two letters,
 * because that is enough to be unambiguous: conversational speech does not
 * hyphenate single letters. Bare whitespace ("Y U S U F") takes three,
 * because two is reachable by accident — "is that a b" would otherwise buy
 * three seconds of patience.
 *
 * Two letters matters rather than being a nicety: the measured utterance is
 * *"S-O-F-I-A, last name Lee, L-I"*, and the anchor is the END of the
 * transcript, so the only thing this sees at the moment it has to decide is
 * `L-I`.
 */
const SPELLING_IN_PROGRESS = [
  // Hyphen/period separated: two letters is enough.
  "\\b[a-z](?:\\s*[-.]\\s*[a-z])+\\b[-.,\\s]*$",
  // Whitespace separated: three, so ordinary speech cannot reach it.
  "(?:\\b[a-z]\\s+){2,}[a-z]\\b\\s*$",
].join("|");

/**
 * The agent asking WHO the caller is.
 *
 * Separate from {@link READ_OUT_IDENTIFIERS} and ahead of it in the table,
 * because the measurement says this is the expensive turn: over 9 tau2-bench
 * retail simulations on 3 hard cases, 41 order-id renderings produced exactly
 * one digit substitution and it never reached a tool call, while NAMES
 * collapsed repeatedly — "Yusuf" → "Yuta" → "Yufus" (three failed lookups,
 * then escalation to a human), "Sofia Li" → "Sophia Lee". A name has no
 * checksum and no shape the model can sanity-check, so a single mis-heard
 * syllable authenticates against a fragment or fails the lookup outright.
 */
const IDENTITY_ASKS = [
  "(first|last|full|middle) name",
  "your name",
  "name on the (account|order)",
  "account holder",
  "spell (that|it|your)",
  "who am i speaking (to|with)",
  "may i (have|take) your name",
].join("|");

const READ_OUT_IDENTIFIERS = [
  "order (number|id|i\\.?d\\.?)",
  "confirmation (number|code)",
  "e-?mail",
  "address",
  "phone number",
  "zip( code)?",
  "post(al )?code",
  "account number",
  "card number",
  "tracking number",
].join("|");

/** Auxiliaries that open a closed question. See the rule below for the anchoring. */
const CLOSED_QUESTION_OPENERS = [
  "is",
  "are",
  "was",
  "were",
  "do",
  "does",
  "did",
  "can",
  "could",
  "will",
  "would",
  "should",
  "shall",
  "have",
  "has",
  "had",
  "may",
  "might",
].join("|");

export const DEFAULT_ENDPOINTING_RULES: readonly EndpointingRule[] = [
  {
    // A caller SPELLING something out, in progress — see
    // SPELLING_IN_PROGRESS for the two arms. First in the table because it is
    // the longest wait and the least ambiguous signal.
    //
    // It is a USER-side rule where Vapi's nearest equivalent (their education
    // preset) is an assistant-side `(spell|define|explain|example)` regex at
    // 4.0s: a caller spells when the agent MIS-HEARD them, unprompted, so
    // keying on the agent's own words misses exactly the turn that matters.
    // The assistant-side half is covered anyway — "spell that" is in
    // `IDENTITY_ASKS`.
    type: "user",
    regex: SPELLING_IN_PROGRESS,
    timeoutMs: 3000,
  },
  {
    // The agent asking who the caller is. 3000 rather than the 2600 the
    // identifier rules get: a caller who has already been mis-heard once
    // slows down and spells, and the inter-letter pauses are longer than the
    // 1455ms worst case measured for ordinary dictation. It stays 500ms under
    // the 3500 `max_turn_silence` ceiling, so an utterance that never reads
    // complete is still force-ended by the ceiling rather than by nothing.
    type: "assistant",
    regex: `\\b(${IDENTITY_ASKS})\\b`,
    timeoutMs: 3000,
  },
  {
    // "your order number", "the order id", "your email", "your zip code".
    // Substring, so "reorder number" matches too, which is the right answer
    // for this rule.
    type: "assistant",
    regex: `\\b(${READ_OUT_IDENTIFIERS})\\b`,
    timeoutMs: 2600,
  },
  {
    // The transcript's last character is a digit: a caller part-way through
    // reading a number out. `\s*$` rather than `$` because an interim often
    // carries a trailing space.
    type: "user",
    regex: "\\d\\s*$",
    timeoutMs: 2600,
  },
  {
    // A closed question: the agent's last SENTENCE opens with an auxiliary and
    // ends in a question mark. Anchored at both ends on purpose — an
    // unanchored "is" would match every sentence containing the word.
    //
    // LAST of the three, which is what decides "Can you give me your order
    // number?": both this and the identifier rule match it, and first-match
    // wins, so patience beats brevity. That ordering is the rule, not an
    // accident of how the list was typed — the expensive failure is a
    // truncated identifier.
    type: "assistant",
    regex: `(^|[.!?]\\s+)(${CLOSED_QUESTION_OPENERS})\\b[^.!?]*\\?\\s*$`,
    timeoutMs: 900,
  },
];
