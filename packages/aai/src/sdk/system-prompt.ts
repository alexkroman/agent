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
 *
 * **The sections themselves are `system-prompt-sections.ts`**, which they
 * moved to at the 500-line source cap. They are re-exported below, so
 * `./system-prompt.ts` remains the single import path for the prompt and its
 * assembly both.
 */

import type { AgentConfig } from "./_internal-types.ts";
import { warnDuplicatedDefaultPrompt } from "./_prompt-duplicate-warning.ts";
import {
  PROMPT_LISTENING,
  PROMPT_PERSONALITY,
  PROMPT_ROLE,
  PROMPT_SPEAKING,
  PROMPT_TOOLS,
} from "./system-prompt-sections.ts";
import { voicePresetSection } from "./voice-presets.ts";

export {
  PROMPT_LISTENING,
  PROMPT_PERSONALITY,
  PROMPT_ROLE,
  PROMPT_SPEAKING,
  PROMPT_TOOLS,
} from "./system-prompt-sections.ts";

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
 *   2a. The opt-in presets an agent declared (`voicePresets`)
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
 * @param options.hasTools - When `true`, includes the TOOLS section (preamble
 *   discipline, results-not-intentions, mis-hearing retries, error handling).
 * @param options.voice - Reserved. The delivery rules are always included today
 *   because every S2S session speaks; if a text-channel mode ships, gate
 *   `PROMPT_SPEAKING` (and swap `PROMPT_ROLE` for a text variant) here.
 * @param options.toolGuidance - Extra per-tool guidance lines from built-in tools.
 * @returns The assembled system prompt string.
 */
export function buildSystemPrompt(
  config: AgentConfig,
  options: { hasTools: boolean; voice?: boolean; toolGuidance?: readonly string[] | undefined },
): string {
  const custom = stripDefaultPrefix(config.systemPrompt);

  const today = new Date().toLocaleDateString("en-US", DATE_FORMAT_OPTIONS);

  const sections: string[] = [PROMPT_ROLE, PROMPT_PERSONALITY, PROMPT_SPEAKING, PROMPT_LISTENING];

  if (options.hasTools) {
    sections.push(PROMPT_TOOLS);
  }

  // After the defaults, before the author's — the precedence the block states.
  const presets = voicePresetSection(config.voicePresets);
  if (presets !== undefined) sections.push(presets);

  sections.push(`Today's date is ${today}.`);

  if (options.toolGuidance && options.toolGuidance.length > 0) {
    sections.push(`Built-in tool usage:\n${options.toolGuidance.join("\n")}`);
  }

  if (custom !== undefined) sections.push(agentInstructionsSection(custom));

  return sections.join("\n\n");
}

/**
 * The author's own instructions under the precedence header the assembled
 * prompt gives them.
 *
 * Exported because a RESOLVER's output has to land in the same place a static
 * `systemPrompt`'s does, and the runtime composes that one per request rather
 * than through {@link buildSystemPrompt} (whose expensive half is cached per
 * calendar day). Two copies of this sentence is how a dynamic prompt would come
 * to carry a different precedence claim from a fixed one.
 *
 * @internal
 */
export function agentInstructionsSection(instructions: string): string {
  return (
    "Agent-specific instructions (these override the defaults above " +
    `where they conflict):\n${instructions}`
  );
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
 * **Both cases now SAY so** ({@link warnDuplicatedDefault}). A silent repair is
 * how the false premise survived so long: an author following the old advice
 * saw a prompt that worked, and the one shape this function will not repair —
 * the mid-string copy, which the old advice's own rationale (interpolate when
 * part of the prompt is computed) produces — cost ~10,000 duplicated characters
 * a turn with nothing anywhere reporting it. Detecting a contained copy is one
 * `includes`; splicing it out is still out of scope.
 *
 * `undefined` covers three cases that mean the same thing to the caller: no
 * prompt was given, the prompt IS the default (the check this replaces), and the
 * prompt was the default plus nothing but whitespace.
 */
function stripDefaultPrefix(systemPrompt: string | undefined): string | undefined {
  if (systemPrompt === undefined || systemPrompt === "") return undefined;
  const leading = systemPrompt.startsWith(DEFAULT_SYSTEM_PROMPT);
  if (leading || systemPrompt.includes(DEFAULT_SYSTEM_PROMPT)) {
    warnDuplicatedDefaultPrompt(systemPrompt, {
      leading,
      defaultLength: DEFAULT_SYSTEM_PROMPT.length,
    });
  }
  const rest = leading
    ? // Only the leading blank line the composed form puts between the two —
      // `trimStart` rather than a fixed `\n\n`, since an author may have used
      // one newline or three.
      systemPrompt.slice(DEFAULT_SYSTEM_PROMPT.length).trimStart()
    : systemPrompt;
  return rest === "" ? undefined : rest;
}
