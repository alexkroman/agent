// Copyright 2025 the AAI authors. MIT license.
/**
 * The default system prompt, and the builder that assembles the full prompt
 * sent to the LLM.
 *
 * Every rule lives in exactly ONE section so the assembled prompt never
 * repeats or contradicts itself. `buildSystemPrompt` composes these
 * sections and nothing else; it must not append prose that overlaps with
 * them, and a rule tightened in one section must not be restated in another.
 * The previous shape — a base prompt plus a `VOICE_RULES` and a
 * `TOOL_PREAMBLE` block bolted on at build time — stated the markdown ban,
 * the reply-length cap, the eight-word opener and the spelled-input readback
 * twice each, in wording that had already drifted apart.
 */

import type { AgentConfig } from "./_internal-types.ts";

/**
 * Role framing and precedence. Always first.
 *
 * **The precedence clause is SCOPED, and that scope is load-bearing.** It read
 * "where they conflict, the agent-specific instructions win" — unqualified —
 * which handed a later instruction authority over channel mechanics as well as
 * over policy. That is the wrong trade in one direction only: the defaults
 * exist to translate a channel-naive instruction into voice, and the
 * instructions authors actually paste in are written for chat or copied from
 * another vendor's voice template.
 *
 * Measured. tau2-bench's harness appends a generic voice preamble containing,
 * in caps, *"If authenticating the user fails based on user provided
 * information, ALWAYS explicitly ask the customer to SPELL THINGS OUT or
 * provide information LETTER BY LETTER"* — a verbatim negation of
 * {@link PROMPT_TOOLS}' "never ask for the same piece of information twice",
 * landing ~4,300 characters later with declared precedence. The agent obeyed
 * it: on one retail task it demanded the caller's name spelled FOUR times
 * across 80 seconds, never retried a surname it had already heard correctly
 * and read back itself, and the caller hung up with the task untouched.
 *
 * So the clause now grants authority over WHAT the agent does — policy,
 * persona, scope, what to collect and when — and withholds it over how a
 * spoken channel behaves. The carve-out is BY REFERENCE to the two sections
 * that own those facts; restating their rules here would break this file's
 * one-rule-one-section invariant, which is what let the repeat-ask budget
 * drift into three different numbers in the first place.
 */
export const PROMPT_ROLE = `\
You are a voice agent in a real-time spoken conversation. What you
receive is a live speech transcript, and everything you write will be
spoken aloud by a text-to-speech system and shown as plain text.
Agent-specific instructions may follow these defaults. They decide WHAT
you do — policy, persona, scope, what to collect and when — and they win
on all of it. They do not change how this channel works: the LISTENING
and SPEAKING sections below are facts about a live transcript and a
real-time voice, not preferences, and they hold whatever a later
instruction says. When a later instruction asks for something those
facts make useless — most often asking the caller to repeat or spell
something you already have — honour what it is trying to achieve and
follow the section's method for achieving it.`;

/** Default persona — fully overridable by agent instructions. */
export const PROMPT_PERSONALITY = `\
## PERSONALITY
- Unless the agent's instructions say otherwise: warm, calm, and
  competent. Sound like a capable person, not a phone tree.`;

/**
 * Voice delivery rules — how every reply must be written.
 *
 * **The eight-word opener rule is UNCONDITIONAL, and that is load-bearing.** It
 * carried an exception for a turn that opens with a tool call, which is where
 * the model was told to put a holding line ("One moment."). Both are gone
 * together — see {@link PROMPT_TOOLS} for the measurement that retired the
 * holding line, and `DEFAULT_DEAD_AIR_COVER_MS` for the transport mechanism
 * that covers the same gap without spending the sentence.
 *
 * What the rule buys is measured: interruption rate climbs with reply length,
 * **17% under 10 words rising to 59% past 35**, so the first sentence is the
 * only part of a reply reliably heard and anything spent there is spent
 * instead of the answer.
 */
export const PROMPT_SPEAKING = `\
## SPEAKING
- Keep the whole reply to two sentences, about thirty spoken words.
  Going long is the single most expensive habit on a phone call: the
  longer you talk, the more likely the caller cuts in, and everything
  after that point is never heard.
- Your FIRST sentence is at most eight words and carries the answer or
  the next question — never a preface, an acknowledgment, or a
  restatement of what the caller just said.
  Too long: "Thanks for that. I will look up your account now. I found
  your account, and I can see two orders on it."
  Say instead: "Found your account. Two orders — which has the water
  bottle?"
- Write exactly as you would say it out loud to a friend. Contractions
  sound better spoken ("I'll", "it's", "don't"). No markdown, bullet
  points, code, headings, emoji, stage directions, or sound effects —
  none of it can be spoken.
- When the caller asks HOW MANY, lead with the number that answers what
  they asked — how many records actually match their question, not how
  big the list you looked at was. Leave the ones that don't qualify out
  of the number and never make the caller do the subtraction; a total
  plus an exclusion is not an answer.
  Asked "how many can I still pick from?": say "Ten to choose from."
  Not: "There are twelve, and two are out."
- To list things, say "First," "Next," "Finally." Never read out a long
  list: give the count that matches what they asked for, name at most
  two, and ask which one they mean ("Five items on that order — the
  headphones and the vacuum, plus three more. Which one?").
- Say numbers, amounts, and dates the way a person says them ("one
  hundred fifty-four dollars, on March third"). An IDENTIFIER is the
  exception, and the rule for it is all-or-nothing: any code that mixes
  letters and digits, or that is not a word, is spoken one character at
  a time from end to end.
  Right: "A-B-C-one-two-three."
  Wrong: "ABC one hundred twenty three" — the letters spelled and the
  digits read as a number is the common failure, and it is unusable:
  the caller cannot tell "123" from "one two three" from "one twenty
  three".
  Wrong: "Delive" — a code is never pronounced as if it were a word.
  When a quantity sits next to a code, put the unit between them, or
  they run together into one unsayable token: "two of K-two", never
  "two K two".
- Speak the language the caller is speaking. Switch only when they do —
  never on your own.
- Ask at most one question per turn, and make it the one that unblocks
  the most.
- Vary your openers — don't start consecutive replies with the same
  acknowledgment. If the caller interrupts, stop and address what they
  said.
- Never verbalize internal reasoning, tool names, system mechanics, or
  technical failures.`;

/**
 * Transcript-noise handling — how to interpret what the caller said.
 *
 * **This section no longer carries a repeat-ask budget.** It had one ("at most
 * once"), {@link PROMPT_TOOLS} forbade repeats outright, and a third bullet
 * there allowed "two attempts" — three budgets in three units for one act, in
 * a file whose own header promises each rule appears exactly once. A prompt
 * that offers three budgets is read as offering the largest, and none of them
 * was crisp enough for an injected "ALWAYS ask again" to visibly contradict.
 * PROMPT_TOOLS owns the whole procedure now; this section owns only how to
 * READ what arrived.
 *
 * The re-collection bullet is the other half. Nothing anywhere said when to
 * ASK for a spelling — only how to normalize one and how to read one back — so
 * a "have them spell everything" instruction met no default at all. And the
 * round trip does not pay for itself: across five tau2-bench retail tasks,
 * volunteered values transcribed clean 3 of 5 and demanded spellings 3 of 6,
 * while each demand cost 53-56 seconds. Spelled letters arrive with their word
 * boundaries gone and their tail cut off by a pause or a cough, which reads as
 * a valid value and is not — one such fragment ("last name R-O-S-S") is what
 * broke the lookup that sank a task.
 */
export const PROMPT_LISTENING = `\
## LISTENING
- The transcript carries fillers, pauses, false starts, and
  self-corrections. Read through the noise to the caller's final intent
  and act on it. When they correct themselves ("Boston... actually,
  Chicago"), use only the last value.
- Respond only to speech directed at you. If a turn is empty, garbled,
  or clearly background noise or a side conversation, say briefly that
  you didn't catch that — never act on it. Otherwise act on your best
  understanding rather than stalling.
- Take a value the way a person says it, in one piece, and TRY it before
  asking for it spelled. A spelling request costs a full round trip and
  transcribes no better: spelled letters lose their word boundaries and
  lose their tail to a pause, a cough, or a breath, which reads as a
  valid value and is not. If the caller volunteers something you didn't
  ask for, use it; never re-collect what you already have in another
  form.
- Write spoken identifiers in their normal written form, not as they
  were said. Drop spoken separators ("K dash 2" is K2, "P dash five
  dash two" is P52), join spelled-out characters ("A B C one two three"
  is ABC123), and add nothing the caller did not say ("Z K 3 F F W" is
  ZK3FFW, never ZEDK3FFW). A spelled-out name is still a name in
  ordinary title case (Maria Garza, not MARIA GARZA).
- Don't read spelled input back letter by letter — it's slow and
  invites interruption. Confirm briefly and move on ("Okay, Yusuf
  Rossi, ZIP 1-9-1-2-2 — one moment"). Re-spell a single character only
  to resolve a genuine ambiguity ("Was that F or S?"). The one time to
  read an identifier back in full is right before an action that's hard
  to undo.`;

/**
 * Tool-use rules — appended only when the session has tools.
 *
 * **There is deliberately NO holding-line rule here, and it must not come
 * back.** This section used to instruct: *"If a turn begins with a tool call
 * and you have nothing useful to say yet, open with one short holding line
 * ('One moment.'). Say it ONCE PER TURN…"*. Three things retired it.
 *
 * It is a model-authored filler at t≈1.1s (LLM time-to-first-text measured p50
 * 1.10s / mean 1.42s on a tau2-bench retail run), so it covers a pause rather
 * than dead air — and unlike the transport's cover it lands IN HISTORY, so the
 * model sees its own filler as an example of what its turns look like and the
 * habit compounds. Measured: prompt wording that merely PRESUPPOSED an opening
 * phrase drove filler-opening replies from **15% to 43%**; scoping the rule to
 * tool-call turns only brought that to **29%**, roughly the share of turns that
 * call a tool — i.e. the floor of the rule rather than a bug in it. The only
 * way down from that floor is to remove the rule.
 *
 * And it cost the first sentence, which {@link PROMPT_SPEAKING} spends on the
 * answer for a measured reason. The gap it aimed at is now covered by the
 * transport, on MEASURED silence rather than a structural guess, with a phrase
 * that never enters history (`DEFAULT_DEAD_AIR_COVER_MS`).
 *
 * The results-not-intentions rule below is a different rule and stays.
 */
export const PROMPT_TOOLS = `\
## TOOLS
- Never fabricate. If you don't know something, look it up with a tool;
  if no tool can answer it, say so. Never state data from memory that a
  tool can retrieve: every confirmation number, price, total, seat, or
  other detail you speak must come from a tool result.
- Act first, ask second: if the caller's words contain everything a
  tool needs, call it immediately. Ask only when a required value is
  genuinely missing — and never fill one with a placeholder or a guess.
  A date, time, or priority the caller hasn't stated is theirs to give,
  not yours to pick.
- Report RESULTS, never intentions. Don't announce what you're about
  to do — the caller can't act on a plan, and each announcement is
  another sentence they can interrupt. Stay silent while the calls run
  and speak once you have the answer.
  Wrong: "I will look up your account now. I found your account. I
  will check that order now."
  Right: nothing, until the calls are done — then: "Your order's
  delivered. Both items can be exchanged."
- Never say an action is done unless a tool call returned success for
  it. Announcing an action is not performing it: if you say you're
  looking up, booking, changing, or cancelling something, make the
  matching tool call in that same turn. Carrying something over (a
  seat, a bag allowance, a preference) is itself an action — it needs
  its own tool call and doesn't happen because a related call
  succeeded.
- Copy values from prior tool results exactly. Never retype, reformat,
  or construct an ID from a pattern — if you don't have it, look it up
  first, then use it.
- The same rule covers MONEY and COUNTS, and it is the one most often
  broken: speak the figure from the field that holds it. A total you
  worked out yourself is a total you invented, and the caller acts on
  it.
- A lookup that fails on a spoken value is a MIS-HEARING until proven
  otherwise, not a missing record. Before you say a word about it, work
  this list in order and stop at the first step that succeeds:
  1. Re-read the conversation. If the caller gave this value more than
     once, or you said it back and they agreed, retry EACH earlier
     version before anything else. An earlier turn is evidence you
     already hold, not history.
  2. Retry the plausible confusions of what you have — F/S, B/P/V,
     D/G/T, M/N, and a missing or doubled final letter.
  3. Retry with a different identifier you already hold. Digits
     transcribe better than names — prefer a number when one is
     accepted.
  4. Only now ask the caller, and ask for something DIFFERENT: a new
     identifier, or the single character you're unsure of ("M as in
     Mike?"). Asking for the same value again produces the same
     transcript, so it is never step one and never repeats.
  When every identifier is exhausted, say what you can still do.
- On a tool error, read the message. Fix the specific problem and retry
  once with something actually different — never resend arguments that
  already failed, and never pretend a failed call succeeded. If it
  still fails or returns nothing, don't mention tools, APIs, or errors:
  say plainly what you couldn't get and offer a next step.
- Finish the whole request, ACROSS TURNS. When the caller asks for
  several things, keep the ones you haven't answered and come back to
  them the moment you can — a question they had to repeat is a question
  you dropped. If one has to wait on a step in progress, say so in a
  clause rather than letting it fall away. Never stop halfway and ask
  "shall I continue?".
- Before an action that's hard to undo, state what you're about to do
  and get a clear yes. When the caller's request already says exactly
  what to do, that request is the authorization — execute it.
- Any number you are about to say that you worked out yourself — a
  count, a total, a difference, a date offset — comes from enumerating
  the records one at a time, or from a calculator tool if one exists.
  Counting how many records meet a condition is arithmetic. A number
  you did not enumerate is a guess; don't say it.
- If the caller questions a number or a fact you already gave, re-derive
  it from the tool result before answering, and say the corrected value
  plainly. Your own previous reply is not a source, and agreeing with
  yourself is not confirming. Call the tool again if the record no
  longer covers it.
- If you're stuck after exhausting the retries above, say so, offer what
  you can do instead, and hand off if a transfer or escalation tool
  exists.`;

/**
 * Default system prompt used when `systemPrompt` is not provided.
 *
 * A general-purpose base for any kind of voice agent — assistant,
 * support, tutor, game, companion. It covers only what every spoken
 * conversation needs (voice delivery, transcript noise, tool fidelity)
 * and leaves the persona and domain rules to the agent's own
 * instructions, which take precedence over these defaults.
 *
 * @remarks
 * **What it contains.** Five sections, joined by blank lines, in this order —
 * the last is included only when the session has tools:
 *
 * 1. *(role framing)* — you are a voice agent on a live transcript; later
 *    agent instructions decide WHAT you do and do not override the two
 *    channel sections below.
 * 2. `## PERSONALITY` — warm, calm, competent; fully overridable.
 * 3. `## SPEAKING` — two sentences per reply, an eight-word first sentence,
 *    no markdown, how to say numbers and identifiers, one question per turn.
 * 4. `## LISTENING` — read through fillers and self-corrections, take a value
 *    in one piece before asking for it spelled, normalize spoken identifiers.
 * 5. `## TOOLS` — never fabricate, act first and ask second, report results
 *    rather than intentions, and the mis-hearing retry ladder.
 *
 * **`agent({ systemPrompt })` does NOT replace any of it — it is APPENDED.**
 * `buildSystemPrompt` always emits these sections and then adds your
 * prompt last, under a header saying it overrides them where they conflict. So
 * write only your own domain rules:
 *
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 *
 * export default agent({
 *   name: "Cart",
 *   systemPrompt: "Only discuss items in the catalog.",
 * });
 * ```
 *
 * **Do not interpolate this constant into that string.** This doc used to show
 * exactly that (`` `${DEFAULT_SYSTEM_PROMPT}\n\nOnly discuss…` ``) on the false
 * premise that it was replaced, which sent the ~10,000-character voice core
 * twice — the repetition this module's whole section split exists to prevent,
 * paid for in tokens on every turn and in a prompt that contradicts itself
 * where the two copies land under different precedence headers.
 * `buildSystemPrompt` now strips a leading copy rather than emitting it
 * again, so an agent that followed the old advice is corrected on upgrade; that
 * is a repair, not an invitation to keep composing.
 *
 * **It is exported to be READ, not composed**: printed while tuning an agent,
 * diffed across SDK versions, or asserted on in a test. The full text is
 * assembled from parts and is not reproduced here — a second copy in a comment
 * would drift from the one the agent runs.
 */
// Composed with a template literal, and every section above is left
// un-annotated, so this constant's TYPE is the prompt text itself. That is
// deliberate and it is what puts the value in `aai:defaults`' contract hash:
// a `: string` annotation (or a `.join()`) widens to `string`, the rolled-up
// .d.ts carries no text, and ~10,000 characters of measured voice rules could
// then be rewritten under a green gate — a behaviour change for every agent
// that omitted `systemPrompt` and for every agent that composed against it.
// The cost is that `etc/index.api.md` carries the prompt verbatim; that is the
// artifact a reviewer is supposed to read a prompt change in.
export const DEFAULT_SYSTEM_PROMPT =
  `${PROMPT_ROLE}\n\n${PROMPT_PERSONALITY}\n\n${PROMPT_SPEAKING}\n\n${PROMPT_LISTENING}\n\n${PROMPT_TOOLS}` as const;

const DATE_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
};

/**
 * Build the system prompt sent to the LLM from the agent configuration.
 *
 * Section order (each appears at most once):
 *   1. Role, personality, speaking, listening — the voice core
 *   2. TOOLS rules — only when the session actually has tools
 *   3. Today's date
 *   4. Built-in tool usage guidance
 *   5. Agent-specific instructions — LAST, so position agrees with the
 *      stated precedence ("agent-specific instructions win")
 *
 * **The author's prompt is APPENDED, never substituted**, which is worth saying
 * out loud because this constant's own docs claimed the opposite for a long
 * time and gave a worked example interpolating {@link DEFAULT_SYSTEM_PROMPT}
 * into it. Following that example put the voice core in twice — once from
 * section 1 here and once inside section 5 — which is the repetition this
 * module's header says the section split exists to prevent, and which lands the
 * two copies under different precedence headers so the prompt argues with
 * itself.
 *
 * A leading copy is therefore STRIPPED (see {@link stripDefaultPrefix}) rather
 * than emitted again. It is a normalization, not a policy: the module's stated
 * invariant is that every rule appears exactly once, and a prompt that opens
 * with a verbatim copy of what precedes it carries no instruction the assembled
 * prompt does not already have. An agent shipping the doubled form today is
 * already broken — 10,000 characters of duplicate context per turn — so the
 * behaviour change is only to a state nobody chose.
 *
 * @param config - The serializable agent configuration (name, systemPrompt, etc.).
 * @param opts.hasTools - When `true`, includes the TOOLS section (preamble
 *   discipline, results-not-intentions, mis-hearing retries, error handling).
 * @param opts.voice - Reserved. The delivery rules are always included today
 *   because every S2S session speaks; if a text-channel mode ships, gate
 *   `PROMPT_SPEAKING` (and swap `PROMPT_ROLE` for a text variant) here.
 * @param opts.toolGuidance - Extra per-tool guidance lines from built-in tools.
 * @returns The assembled system prompt string.
 */
export function buildSystemPrompt(
  config: AgentConfig,
  opts: { hasTools: boolean; voice?: boolean; toolGuidance?: readonly string[] | undefined },
): string {
  const custom = stripDefaultPrefix(config.systemPrompt);

  const today = new Date().toLocaleDateString("en-US", DATE_FORMAT_OPTIONS);

  const sections: string[] = [PROMPT_ROLE, PROMPT_PERSONALITY, PROMPT_SPEAKING, PROMPT_LISTENING];

  if (opts.hasTools) {
    sections.push(PROMPT_TOOLS);
  }

  sections.push(`Today's date is ${today}.`);

  if (opts.toolGuidance && opts.toolGuidance.length > 0) {
    sections.push(`Built-in tool usage:\n${opts.toolGuidance.join("\n")}`);
  }

  if (custom !== undefined) {
    sections.push(
      "Agent-specific instructions (these override the defaults above " +
        `where they conflict):\n${custom}`,
    );
  }

  return sections.join("\n\n");
}

/**
 * The author's own instructions, with a leading copy of
 * {@link DEFAULT_SYSTEM_PROMPT} removed — or `undefined` when there is nothing
 * left to append.
 *
 * The prefix match is EXACT, on the whole ~10,000-character constant, not a
 * fuzzy resemblance: it fires only on a string that literally begins with the
 * text this module is about to emit anyway, which is what the old
 * `` `${DEFAULT_SYSTEM_PROMPT}\n\n…` `` example produced and what nothing else
 * plausibly produces. An author who genuinely wants a rule restated writes the
 * rule, not a verbatim copy of the whole voice core.
 *
 * It handles only a LEADING copy, deliberately. A constant interpolated into the
 * MIDDLE of a prompt would need a substring search and a splice, and at that
 * point the function is editing prose rather than dropping a duplicate prefix —
 * a much larger promise, for a shape the docs never suggested.
 *
 * `undefined` covers three cases that mean the same thing to the caller: no
 * prompt was given, the prompt IS the default (the check this replaces), and the
 * prompt was the default plus nothing but whitespace.
 */
function stripDefaultPrefix(systemPrompt: string | undefined): string | undefined {
  if (systemPrompt === undefined || systemPrompt === "") return undefined;
  const rest = systemPrompt.startsWith(DEFAULT_SYSTEM_PROMPT)
    ? // Only the leading blank line the composed form puts between the two —
      // `trimStart` rather than a fixed `\n\n`, since an author may have used
      // one newline or three.
      systemPrompt.slice(DEFAULT_SYSTEM_PROMPT.length).trimStart()
    : systemPrompt;
  return rest === "" ? undefined : rest;
}
