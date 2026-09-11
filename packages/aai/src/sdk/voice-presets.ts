// Copyright 2026 the AAI authors. MIT license.
/**
 * The four opt-in prompt presets — named behaviours an agent turns ON, rather
 * than prose every author re-derives.
 *
 * `system-prompt.ts` holds what EVERY voice agent needs and is therefore
 * unconditional; its own header states the rule that keeps it honest ("every
 * rule lives in exactly ONE section"). These four are the other kind: each is
 * worth real tokens on every turn and is wrong for most agents, so none of them
 * can live there. A desk that captures a policy number wants
 * {@link VOICE_PRESETS.echoVerification}; a desk that reads a caller a
 * confirmation code wants `natoAlphabet`; an agent that only answers questions
 * wants neither and should not pay for them.
 *
 * ## They are a LIST, not a mode
 *
 * `agent({ voicePresets: ["echoVerification", "smartMatching"] })`. Each name is
 * one section of prompt text, they compose, they are independently removable,
 * and the cost of each is published below — because a preset is paid for on
 * EVERY model request, which is once per step of a tool-calling reply, not once
 * per call. That is the whole reason this is four names and not one
 * `reliability: true`: bundling them would make the 919-token one the price of
 * the 200-token one.
 *
 * | Preset | Tokens | What it buys |
 * | --- | --- | --- |
 * | `echoVerification` | ~190 | critical values are read back and confirmed before they are acted on |
 * | `smartMatching` | ~200 | a caller's CONFIRMATION, SPELLING and name lookups survive a transcription error |
 * | `speechNormalization` | ~920 | numbers, money, dates, phones, emails and addresses are written as SPOKEN words |
 * | `natoAlphabet` | ~190 | spelling uses "B as in Bravo" with pauses |
 *
 * Measured with `tiktoken`'s `o200k_base` (and within 5 tokens on
 * `cl100k_base`) over the exact strings below; `voice-presets.test.ts` holds
 * each to a band, so an edit that doubles a preset's cost fails rather than
 * being discovered on a bill. They are ports of Retell's "Agent Handbook"
 * toggles and are deliberately in the same size class as the published
 * originals (190 / 110 / 910 / 190) — with one deliberate exception:
 * `smartMatching` is ~200 against their ~110, because a measured tau2-bench
 * baseline showed the confirmation half alone does not reach the failure. Its
 * own doc carries the runs.
 *
 * **`speechNormalization` is the expensive one and is listed last in prose for
 * that reason.** It is ~4.7x the other three combined and it is a PROMPT-LAYER
 * fix: it tells the model to write "seven fifty-eight dollars and eight cents"
 * instead of `$758.08`. It does not touch the audio path, so it is not a
 * substitute for a TTS engine's own normalization and it cannot fix a voice
 * that mispronounces a word it was handed correctly. Reach for the outbound
 * renderers first where the value is the AGENT'S OWN data — `spokenMoney`,
 * `spokenDate`, `spokenTime` (`sdk/spoken-render.ts`) render it in code, for
 * free, with a test that can assert the string. This preset is for the text the
 * MODEL composes, which nothing in code can reach.
 *
 * ## Where they LAND, and why they carry a precedence line
 *
 * `buildSystemPrompt` emits them after `## TOOLS` and before the author's own
 * instructions, so the order of authority is: the framework's voice core, then
 * the presets, then the agent's own rules. Two of them deliberately CONTRADICT
 * the defaults above them — `echoVerification` spells a name back where
 * `## LISTENING` says not to, and `natoAlphabet` spells a code where
 * `## SPEAKING` says to read the characters — which is exactly why they are
 * opt-in, and why {@link VOICE_PRESET_PRECEDENCE} is emitted once above them.
 * Without that line the assembled prompt argues with itself and the model picks
 * a side per turn. With it, turning a preset on is a decision the prompt states.
 *
 * The defaults they override are measured (see `PROMPT_LISTENING`: a demanded
 * spelling cost 53-56 seconds per round trip on tau2-bench retail, and spelled
 * letters transcribe no better than a volunteered value). So `echoVerification`
 * and `natoAlphabet` are for a desk where a wrong value is worse than a slow
 * call — a prescription, a payment, a dispatch address — not a default anybody
 * should reach for twice.
 *
 * `smartMatching` is the one with no such tension, and the one with a measured
 * case: it says a near-match the caller CONFIRMED is a match, that a SPELLED
 * value replaces what was heard, and that a name a lookup misses is a
 * transcription to doubt. Nothing in the core prompt covers the first two, and
 * the third is where the core's own retry ladder was measured to stall. It is
 * the hardest of the four to write by hand, because every failure it prevents
 * looks like success from inside the transcript.
 */

/**
 * One of the four opt-in prompt presets — see {@link VOICE_PRESETS} for what
 * each one says and what it costs.
 *
 * Spelled as a union rather than derived from `VOICE_PRESET_NAMES`,
 * which would be the shorter way round: a derived alias renders in the API
 * report and the docs as `(typeof VOICE_PRESET_NAMES)[number]`, naming an
 * internal constant a reader cannot import and TypeDoc refuses to link. The
 * union renders as the four strings, which is the answer to the only question
 * anybody asks of this type.
 *
 * @public
 */
export type VoicePresetName =
  | "echoVerification"
  | "smartMatching"
  | "speechNormalization"
  | "natoAlphabet";

/**
 * The preset names, in the order {@link voicePresetSection} emits them.
 *
 * The ORDER is what this tuple is for — the prompt reads best as capture, then
 * believe the confirmation, then say it, then spell it — and it doubles as the
 * source of `VoicePresetNameSchema` (`type-schemas.ts`), so the wire vocabulary
 * cannot drift from the emitted one. Totality against {@link VoicePresetName}
 * is not something `satisfies` can check, so it is checked where it can be: the
 * schema's inferred type is asserted equal to the union
 * (`schema-alignment.test.ts`), and {@link VOICE_PRESETS}' keys are asserted
 * equal to this tuple.
 *
 * @internal
 */
export const VOICE_PRESET_NAMES = [
  "echoVerification",
  "smartMatching",
  "speechNormalization",
  "natoAlphabet",
] as const satisfies readonly VoicePresetName[];

/**
 * The line emitted once above whatever presets are on.
 *
 * ~30 tokens, paid once however many presets are enabled, and it is what makes
 * the block composable at all: two of the four contradict a rule in
 * `## SPEAKING` or `## LISTENING`, so without a stated precedence the assembled
 * prompt holds both claims and neither wins. Stated here rather than inside
 * each preset so the sentence appears exactly once — the invariant
 * `system-prompt.ts`'s header sets for the sections above it.
 *
 * @internal
 */
export const VOICE_PRESET_PRECEDENCE = `\
The sections below are optional behaviours this agent has switched on.
Where one of them conflicts with SPEAKING or LISTENING above, the
section below wins; everything they do not mention is unchanged.`;

/**
 * Read every critical value back and get a yes before acting on it.
 *
 * ~190 tokens. The read-back is GROUPED and closed with one question, because
 * the failure this replaces is not "the agent did not confirm" — it is an agent
 * confirming three values in three turns, each of which is a chance for the
 * caller to interrupt (interruption rate is 17% under 10 words and 59% past 35;
 * see `PROMPT_SPEAKING`).
 *
 * It spells an UNCOMMON name back and says so narrowly, because
 * `PROMPT_LISTENING` forbids letter-by-letter read-back in general for a
 * measured reason and this preset is the exception, not its repeal.
 */
const ECHO_VERIFICATION = `\
## ECHO VERIFICATION
- Read every critical value back before you act on it or save it: names,
  phone numbers, emails, dates, times, addresses, amounts, and
  confirmation or reference codes.
- Group the values that belong together into ONE read-back, then ask one
  closed question. "Just to confirm, your first name is Ryan, last name
  is Ashford — is that correct?" Three values confirmed in three turns
  is three chances to be cut off.
- Spell an uncommon or ambiguous name letter by letter as you read it
  back: "That's A-S-H-F-O-R-D, Ashford." A common name read back as a
  word is enough — don't spell what nobody mishears.
- If the caller corrects part of it, read back only the corrected value.
  Never re-confirm what they already agreed to, and never ask again for
  a value they have confirmed.`;

/**
 * Believe the caller through a transcription error: on a confirmation, on a
 * SPELLED correction, and on the lookup the mis-heard value goes into.
 *
 * ~200 tokens, and the cheapest of the four relative to what it prevents. Its
 * first bullet is the confirmation loop that cannot terminate — the agent
 * proposes "Brandon", the ASR renders the caller's yes as "this is Brendon",
 * and an agent comparing strings asks again, producing the same transcript
 * forever.
 *
 * **The other two bullets are MEASURED, and they are why this is ~200 tokens
 * rather than the ~110 the Retell toggle it ports costs.** On a tau2-bench
 * retail baseline (9 simulations over 3 hard cases, mean reward 0.444) the
 * conversational half was not where the reward went:
 *
 * - "Sofia Li" transcribed as "Sophia Lee", fed straight into
 *   `find_user_id_by_name_zip`, and the miss treated as authoritative — the
 *   agent retried the same string and then escalated to a human. So the
 *   tolerance has to cover the TOOL-ARGUMENT direction, not just the
 *   conversational one, and "a name a lookup cannot find is a transcription to
 *   DOUBT" is the bullet that says so.
 * - The caller then SPELLED it, letter by letter, and the agent kept using the
 *   mis-heard form. **That half was NOT the model's fault, and the attribution
 *   matters more than the anecdote**: `assembleSpelledRuns`
 *   (`sdk/_wire-helpers.ts`, applied by `aai-runtime`'s
 *   `transports/pipeline-user-speech.ts`) split on whitespace and commas only,
 *   so a hyphen-joined rendering arrived as ONE token, produced no spelled run,
 *   and the `[spelled aloud: …]` annotation the model reads was never
 *   generated. The signal was dropped before the prompt saw it. So this bullet
 *   is the half that makes the model ACT on that annotation, and it DEPENDS on
 *   the producer: without the tokenizer fix the rule has nothing to prefer.
 *   Note also what it implies about `echoVerification`, which ASKS for a
 *   spelling: asking is not the hard part, and a preset that only asked would
 *   not have saved this run.
 *
 * Names are also the right entity class to spend the tokens on. In the same
 * corpus ZIP codes transcribed correctly every time and order ids were near
 * perfect (one digit wrong in 41 renderings, never reaching a tool). **Read
 * that as "clean where it was exercised", not "digits are solved"** — it is a
 * three-case sample, one of those cases is DESIGNED around a caller
 * volunteering a real but wrong order id, and another case's poisoned-chain
 * path never fired in the baseline at all. The scoping is a defensible default
 * on that evidence and not a finding about digits.
 *
 * **What the phonetic-neighbour bullet does NOT reach, so nobody credits it
 * with a run it cannot win:** a MANGLING is not a neighbour. In the same
 * corpus "Yusuf" came back as "Yuta" and then "Yufus", and no retry over
 * plausible confusions gets from "Yuta" to "Yusuf" — that task burned three
 * lookups and ended in a human transfer after 191 seconds, and it is
 * recoverable on the ASR side (keyterms, per-turn context) rather than in a
 * prompt. This preset addresses the Sofia/Sophia mechanism and not that one.
 *
 * **Its examples may not name a benchmark entity, and that constraint outlives
 * this preset.** The vivid pairs are the ones the evidence hands you, and
 * writing them into the prompt puts the answer key in context for the very
 * cases the gate measures — "case 51 recovers" then shows only that the
 * mechanism fires when the exact pair is named. So the shipped text teaches
 * with names that occur ZERO times in `data/tau2/domains` (all five domains,
 * 142 MB, checked rather than assumed) and `voice-presets.test.ts` holds the
 * contaminating ones out by name. The measurement belongs in this comment; the
 * illustration does not.
 *
 * Do not confuse that with BOOSTING a name: feeding the agent's own account
 * base to the transcriber (STT keyterms, per-turn context) is ordinary product
 * behaviour, since a real deployment has that data and may query it. What is
 * forbidden is naming a corpus entity in prompt TEXT that ships to every
 * caller.
 *
 * It stays scoped to values the caller has GIVEN or AGREED to. It does not
 * license accepting a near-match on a value nothing has confirmed, which is
 * what `PROMPT_TOOLS`' retry ladder is for — this preset makes that ladder's
 * first rungs specific to a name, which is where it was measured to stall.
 */
const SMART_MATCHING = `\
## SMART MATCHING
- A transcript is approximate, so a NEAR-match on a value you proposed
  is a MATCH: you ask "Are you Brandon?", the transcript reads "Yes,
  this is Brendon" — that is a yes. Keep the value you hold and go on.
- When the caller SPELLS a value, the letters ARE the value: they
  REPLACE what you heard, exactly as spelled — "M-A-R-T-A" is Marta,
  never Martha — and every later lookup uses the spelled form.
- A name a lookup cannot find is a transcription to DOUBT, not a
  missing record. Before you re-ask or hand off, retry its phonetic
  neighbours (Katherine/Kathryn, Clara/Klara) and any form spelled
  earlier.
- Never make the caller repeat what they have confirmed or spelled;
  asking again produces the same transcript. Ask only when the
  difference changes WHO or WHAT is meant.`;

/**
 * Write numbers, money, dates, times, phone numbers, emails and addresses as
 * the words a person says.
 *
 * ~920 tokens — by far the most expensive thing in this module, which is why
 * the module doc leads with the cheaper ways to get the same result for data
 * the agent already holds.
 *
 * **The spaced dash in the phone rule is a TTS trick, not typography.**
 * `"four one five - eight nine two - three two four five"` reads with a pause
 * at each group because the dash has a space on either side; written
 * `415-892-3245`, or even `four one five-eight nine two`, the engine runs the
 * groups together into one unusable token. Retell's own prompt guide is
 * explicit about not omitting the space, and it is the one line in this preset
 * that looks like a formatting slip and is load-bearing.
 *
 * The email spelling (`n-a-m-e-@-c-o-m-p-a-n-y-dot-com`), the "@" as "at" and
 * the "never o'clock" time rule come from the same source. Everything else is
 * this SDK's existing outbound-speech rules written for the model instead of
 * for a renderer.
 */
const SPEECH_NORMALIZATION = `\
## SPEECH NORMALIZATION
Everything you write is read aloud verbatim, so write the WORDS, never
the written form. Convert before you speak, in these categories.

**Numbers.** Say a quantity as a person says it: "1,247" is "twelve
hundred forty-seven", "0.5" is "point five", "3/4" is "three quarters",
"2x" is "two times". Years are spoken in pairs — "2026" is "twenty
twenty-six", "1908" is "nineteen oh eight". Ordinals are words: "3rd" is
"third". Ranges take "to": "10-15" is "ten to fifteen". Keep a number
that is an IDENTIFIER digit by digit instead — see codes below.

**Money.** "$758.08" is "seven fifty-eight dollars and eight cents".
"$1,200" is "twelve hundred dollars". "$0.99" is "ninety-nine cents".
"$1.5M" is "one point five million dollars". Lead with the word "minus"
for a negative: "-$40" is "minus forty dollars". Never say the symbol,
never say "point" between dollars and cents.

**Dates.** "3/5/2026" is "March fifth, twenty twenty-six". Month first,
day as an ordinal, year in pairs. Drop the year when it is this year:
"June 8" is "June eighth". "2026-06-08" is spoken the same way — never
read the hyphens.

**Times.** "3:30 PM" is "Three thirty PM". "9:00 AM" is "Nine AM" —
never "o'clock", never "nine hundred hours", never "nine zero zero".
"12:05" is "twelve oh five". A duration is words: "1h 30m" is "an hour
and a half".

**Phone numbers.** Read them digit by digit, grouped, with a dash and a
SPACE on each side of it to make the voice pause: "415-892-3245" is
"four one five - eight nine two - three two four five". Don't omit the
space around the dash when speaking — the spaced dash is what produces
the pause. Say "oh" or "zero" consistently, and never group digits into
numbers ("eight ninety-two" is wrong). An extension follows as
"extension two two three".

**Emails.** Spell the local part character by character, say "at" for
"@", and "dot" for ".": "name@company.com" is
"n-a-m-e-@-c-o-m-p-a-n-y-dot-com". Say a well-known domain as a word if
it is one ("gmail dot com"), spell an unfamiliar one. "_" is
"underscore", "-" is "dash".

**Addresses.** "123 Main St, Apt 4B" is "one twenty-three Main Street,
apartment four B". Expand every abbreviation — St is Street, Ave is
Avenue, Blvd is Boulevard, Dr is Drive or Doctor by context, Ste is
Suite. A house number under 10,000 is said in pairs: "1420" is "fourteen
twenty". A ZIP code is digit by digit: "19122" is "one nine one two
two". Say a state's full name, not its two letters.

**Codes and identifiers.** Anything mixing letters and digits, or that
is not a word, goes one character at a time end to end: "ABC123" is
"A-B-C-one-two-three", never "ABC one twenty-three". Say the letters in
the same breath as the digits, and never pronounce a code as a word.

**Symbols, units and abbreviations.** Say them: "%" is "percent", "&" is
"and", "#" is "number", "/" is "slash" or "per" by sense, "°F" is
"degrees Fahrenheit", "kg" is "kilograms", "5'9"" is "five foot nine".
Expand a title ("Dr." is "Doctor", "Mr." is "Mister") and spell an
acronym that is not a word ("FAQ" is "F-A-Q", "NASA" is "NASA").`;

/**
 * Spell with NATO phonetics, one character at a time, with pauses.
 *
 * ~190 tokens, most of which is the alphabet itself — and the alphabet is
 * listed rather than named because "use the NATO phonetic alphabet" leaves the
 * model to recall 26 words, and the ones it gets wrong ("Juliet", "Alpha",
 * "Xray") are the ones a caller has to decode.
 *
 * The commas are the pause, exactly as the spaced dash is in
 * {@link SPEECH_NORMALIZATION}: `"B as in Bravo, 7, K as in Kilo, 2"` reads at
 * a speed a caller can write down.
 */
const NATO_ALPHABET = `\
## NATO PHONETIC ALPHABET
- When you spell anything out, use NATO phonetics: Alfa, Bravo, Charlie,
  Delta, Echo, Foxtrot, Golf, Hotel, India, Juliett, Kilo, Lima, Mike,
  November, Oscar, Papa, Quebec, Romeo, Sierra, Tango, Uniform, Victor,
  Whiskey, X-ray, Yankee, Zulu.
- Say the letter and then its word — "B as in Bravo", never "Bravo"
  alone. Digits are said as themselves.
- Separate the characters with commas so the voice pauses between them,
  and close with a confirmation question.
  "That's B as in Bravo, 7, K as in Kilo, 2 — correct?"
- Use it for confirmation codes, reference numbers, emails and postal
  codes, and spell the whole value or none of it.`;

/**
 * The shipped text of every preset, keyed by the name `agent({ voicePresets })`
 * takes.
 *
 * Exported to be READ — printed while tuning an agent, diffed across SDK
 * versions, asserted on in a spec, or quoted into an agent's own
 * `system-prompt.md` when it wants the behaviour with one clause changed. It is
 * the same membership argument `DEFAULT_SYSTEM_PROMPT` passes, and the same
 * warning applies in reverse: do NOT interpolate a value here into your
 * `systemPrompt` in order to turn the preset on. Name it in `voicePresets` and
 * the framework emits it once, above your instructions, under a stated
 * precedence.
 *
 * Un-annotated and `as const`, so the declaration's TYPE is the prompt text:
 * the rolled-up `.d.ts` then carries every word, which is what puts a prompt
 * change in `etc/index.api.md` where a reviewer reads it. `satisfies` is what
 * keeps the record total — a fifth name in `VOICE_PRESET_NAMES` with no
 * text here is a compile error.
 *
 * @example Turn two of them on
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 *
 * export default agent({
 *   name: "Pharmacy Line",
 *   voicePresets: ["echoVerification", "smartMatching"],
 * });
 * ```
 *
 * @public
 */
export const VOICE_PRESETS = {
  echoVerification: ECHO_VERIFICATION,
  smartMatching: SMART_MATCHING,
  speechNormalization: SPEECH_NORMALIZATION,
  natoAlphabet: NATO_ALPHABET,
} as const satisfies Record<VoicePresetName, string>;

/**
 * The presets an agent declared, as one prompt section — or `undefined` when it
 * declared none.
 *
 * Three properties the callers rely on, all of them tested rather than
 * promised: the output is in {@link VOICE_PRESET_NAMES} order whatever order
 * the author wrote (a prompt that varies with the spelling of a config is a
 * prompt nobody can diff); a name repeated is emitted once (the same text
 * twice is the duplication `system-prompt.ts` exists to prevent, in the one
 * place a config can still cause it); and an empty or absent list produces
 * `undefined` rather than an empty section, so an agent with no presets sends
 * the byte-identical prompt it sent before this field existed.
 *
 * It takes `readonly VoicePresetName[]` and not the config object, because the
 * only caller that has a config is `buildSystemPrompt` and the other readers
 * (a spec, a tuning script) have a list.
 *
 * @internal
 */
export function voicePresetSection(
  names: readonly VoicePresetName[] | undefined,
): string | undefined {
  if (names === undefined || names.length === 0) return undefined;
  const enabled = new Set(names);
  const sections = VOICE_PRESET_NAMES.filter((name) => enabled.has(name)).map(
    (name) => VOICE_PRESETS[name],
  );
  // A list holding only unknown strings — a raw `export default {…}` config
  // that skipped the schema — leaves nothing to emit, and an empty section
  // header would be worse than none.
  if (sections.length === 0) return undefined;
  return [VOICE_PRESET_PRECEDENCE, ...sections].join("\n\n");
}

/**
 * The opt-in prompt presets, extended by `AgentDef`.
 *
 * Its own interface for the reason `PipelineVoiceTuning` and the three other
 * field groups have one — `types.ts` sits at the source-length cap, and a group
 * of fields sharing one rule reads better stated once. The rule here is the
 * cost: **every name in the list is paid for on every model request**, and
 * {@link VOICE_PRESETS}' table is the price list.
 *
 * @public
 */
export interface AgentVoicePresets {
  /**
   * Opt-in prompt presets — named reliability behaviours, composed into the
   * system prompt above your own instructions.
   *
   * @defaultValue none — an agent that declares nothing here sends exactly the
   * prompt it sent before the field existed.
   *
   * Each name costs tokens on EVERY model request: `echoVerification` ~190,
   * `smartMatching` ~200, `speechNormalization` ~920, `natoAlphabet` ~190. Turn
   * on what the desk needs and nothing else — see {@link VOICE_PRESETS} for the
   * exact text of each and for what it overrides.
   *
   * ```ts
   * import { agent } from "@alexkroman1/aai";
   *
   * export default agent({
   *   name: "Claims Intake",
   *   voicePresets: ["echoVerification", "smartMatching", "natoAlphabet"],
   * });
   * ```
   *
   * Order is ignored (the framework emits them in a fixed order) and a repeat
   * is emitted once, so a list assembled from a config cannot change the
   * prompt's shape.
   */
  voicePresets?: readonly VoicePresetName[];
}
