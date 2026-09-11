// Copyright 2025 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeConfig } from "../host/_test-utils.ts";
import {
  buildSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
  PROMPT_LISTENING,
  PROMPT_PERSONALITY,
  PROMPT_ROLE,
  PROMPT_SPEAKING,
  PROMPT_TOOLS,
} from "./system-prompt.ts";
import { VOICE_PRESETS } from "./voice-presets.ts";

const VOICE_CORE = [PROMPT_ROLE, PROMPT_PERSONALITY, PROMPT_SPEAKING, PROMPT_LISTENING].join(
  "\n\n",
);
const DATE_LINE = "Today's date is Wednesday, January 15, 2025.";
/**
 * Frozen in LOCAL time, not `Z`, and that is the whole point.
 * `buildSystemPrompt` renders the date with `toLocaleDateString("en-US", …)`
 * and no `timeZone` option, so it reads the runner's zone. A frozen
 * `12:00:00Z` leaves ±12h of slack — enough for common CI regions and not for
 * UTC+13/+14 (Auckland in DST, Tonga, Samoa, Kiritimati), where it renders as
 * the 16th. Local noon on the 15th is the 15th in every zone there is, so
 * nothing has to pin `TZ`.
 */
const LOCAL_NOON = (y: number, monthIndex: number, day: number): Date =>
  new Date(y, monthIndex, day, 12, 0, 0);
const AGENT_HEADER =
  "Agent-specific instructions (these override the defaults above where they conflict):";

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("buildSystemPrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(LOCAL_NOON(2025, 0, 15));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("always opens with the voice core", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result.startsWith(VOICE_CORE)).toBe(true);
  });

  test("does not include agent-specific instructions section for default instructions", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).not.toContain(AGENT_HEADER);
  });

  test("appends custom agent instructions", () => {
    const custom = "You are a pirate. Always speak like one.";
    const result = buildSystemPrompt(makeConfig({ systemPrompt: custom }), { hasTools: false });
    expect(result).toContain(AGENT_HEADER);
    expect(result).toContain(custom);
  });

  // Position has to agree with the precedence PROMPT_ROLE states. When the
  // agent's own instructions sat mid-prompt with defaults after them, the
  // prompt told the model the later text loses.
  test("agent instructions come last, after every default section", () => {
    const result = buildSystemPrompt(makeConfig({ systemPrompt: "Custom rules." }), {
      hasTools: true,
      toolGuidance: ["- Guidance line."],
    });
    expect(result.endsWith(`${AGENT_HEADER}\nCustom rules.`)).toBe(true);
  });

  test("includes the TOOLS section when hasTools is true", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).toContain(PROMPT_TOOLS);
  });

  test("omits the TOOLS section when hasTools is false", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).not.toContain("## TOOLS");
  });

  // The prompt asks for NO holding line at all, and this is the guard on that
  // — the rule drifted back once already. It is the third and largest of three
  // measurements against a model-authored opener. Wording that merely
  // PRESUPPOSED one drove filler-opening replies 15% -> 43%; scoping the rule
  // to tool-call turns only reached 29%, roughly the share of turns that call
  // a tool, i.e. the rule's floor rather than a bug in it. (The earlier
  // scoping fix was itself measured on tau2-bench retail: 42/815 replies
  // stacked two or more preambles, 12 stacked three or more, because "ALWAYS
  // say a brief natural phrase BEFORE the tool call" scopes per CALL.) The gap
  // is now covered by the transport's dead-air cover, on measured silence,
  // with a phrase that never enters history.
  test("states no holding-line rule at all", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).not.toContain("holding line");
    expect(result).not.toContain("One moment.");
    // And the opener rule it used to carve an exception out of is now
    // unconditional: no "one exception" clause survives in SPEAKING.
    expect(result).toContain("FIRST sentence is at most eight words");
    expect(result).not.toContain("The one exception is a turn");
  });

  test("tells the model a not-found lookup may be a mis-hearing", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).toContain("MIS-HEARING until proven");
    // The re-ask must vary: repeating the request replays the same audio and
    // yields the same mis-transcription.
    expect(result).toContain("ask for something DIFFERENT");
  });

  // REMOVED, and recorded so it is not re-added on intuition. A rule telling
  // the agent to mine what the caller had already said (a name inside
  // `mei_kovacs_8020`) was written three times — plain, with a sharpened
  // carve-out, then with an instruction-scope clause — to fix three tasks that
  // dead-ended without a single tool call. Measured at 3 trials x 10 tasks it
  // moved NOTHING: 0.333 +/- 0.086 with it, 0.333 +/- 0.086 without, and the
  // target tasks stayed 0/3 while only ever calling transfer_to_human_agents.
  // The prompt is a shared budget — this file's own history is three
  // contradictory repeat-ask rules — so an unvalidated rule is a cost, not a
  // neutral addition. Re-add only with a measurement.

  // The step task 2 of a tau2-bench retail run skipped: the caller had already
  // spelled the surname correctly, and the agent had read it back, when the
  // lookup on a later mis-heard fragment failed. It asked a fourth time
  // instead of retrying a value sitting in its own context, and the call ran
  // out before the actual task was touched. Searching the transcript must be
  // step ONE of the retry ladder, ahead of the letter-confusion guesses.
  test("the mis-hearing retry ladder searches the conversation first", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    const ladder = result.slice(result.indexOf("MIS-HEARING until proven"));
    const reread = ladder.indexOf("Re-read the conversation");
    const confusions = ladder.indexOf("plausible confusions");
    const askAgain = ladder.indexOf("Only now ask the caller");
    expect(reread).toBeGreaterThan(-1);
    expect(confusions).toBeGreaterThan(reread);
    expect(askAgain).toBeGreaterThan(confusions);
  });

  // Three sections used to carry a repeat-ask budget in three different units
  // ("at most once" / "never" / "two attempts"), which is both a violation of
  // this file's one-rule-one-section invariant and the reason an injected
  // "ALWAYS ask them to spell it" had nothing crisp to contradict. TOOLS owns
  // the whole procedure; nothing else may license a repeat.
  test("only one section carries a repeat-ask budget", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).not.toContain("Ask the caller to repeat at\n  most once");
    expect(result).not.toContain("stuck after two attempts");
    expect(result).toContain("stuck after exhausting the retries above");
  });

  // A later instruction decides WHAT the agent does, never how a spoken
  // channel behaves. Unscoped precedence is what let tau2-bench's generic
  // voice preamble ("ALWAYS explicitly ask the customer to SPELL THINGS OUT")
  // delete the rule that keeps a call from deadlocking on a re-ask loop.
  test("precedence is scoped away from channel mechanics", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).toContain("They do not change how this channel works");
    expect(result).not.toContain("where they\nconflict, the agent-specific instructions win");
  });

  // A count answers the question that was asked. Reporting the collection size
  // plus an exclusion ("twelve options, two unavailable") makes the caller do
  // the subtraction, and a tau2-bench NL judge scored exactly that as a miss.
  test("SPEAKING requires the asked-for count, not the collection size", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toContain("When the caller asks HOW MANY");
    expect(result).toContain("never make the caller do the subtraction");
  });

  // Counting records that meet a condition is arithmetic. Both this rule and
  // the `calculate` builtin's own description used to enumerate only currency
  // operations, and the model read them that way: on one run it called the
  // calculator for a price delta and then, 1.1s later, spoke a hand-estimated
  // count that was wrong by one.
  test("TOOLS treats a count as arithmetic and forbids agreeing with itself", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).toContain("Counting how many records meet a condition is arithmetic");
    expect(result).toContain("Your own previous reply is not a source");
  });

  // The dominant failure across all three voice benchmarks: the agent says
  // "your window seat is reserved" having never called assign_seat, so the
  // final DB has seat=null. EVA scored faithfulness 0.075 on this alone.
  test("TOOLS forbids claiming an action without a successful tool result", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).toContain("Never say an action is done");
    expect(result).toContain("Carrying something over");
  });

  test("the claim-an-action rule is tool-gated", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).not.toContain("Never say an action is done");
  });

  // Delivery rules are unconditional: every session this builder serves
  // speaks, so gating them behind `voice` only ever produced a prompt that
  // told a speaking agent it could emit markdown.
  // `voice` is reserved rather than honoured, so it is passed by omission as
  // well as explicitly — `exactOptionalPropertyTypes` makes those two
  // genuinely different calls.
  test.each([
    ["voice: true", { hasTools: false, voice: true }],
    ["voice: false", { hasTools: false, voice: false }],
    ["voice omitted", { hasTools: false }],
  ])("delivery rules are present with %s", (_label, opts) => {
    const result = buildSystemPrompt(makeConfig(), opts);
    expect(result).toContain("Keep the whole reply to two sentences");
    expect(result).toContain("No markdown, bullet");
    expect(result).toContain("FIRST sentence is at most eight words");
  });

  // 30% of all synthesized agent audio in the tau2 run was discarded by
  // barge-in — the caller interrupts partway through an enumerated list and
  // never hears the rest.
  test("SPEAKING forbids reading long results out item by item", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toContain("Never read out a long\n  list");
  });

  // The identifier rule is a SPELLING rule, and these pin the spelling rather
  // than the intent. "Spoken one character at a time" is not a thing a model
  // that only picks characters can comply with: across 1,811 tau2-bench retail
  // calls 2.8% of agent turns still carried a bare `W`-plus-digits order
  // number and 3.4% a bare digit run of seven or more, both worse in the
  // newest runs than the oldest. Measured through AssemblyAI TTS with
  // recognition formatting off, `#W2378156` is spoken "W two million three
  // hundred seventy-eight thousand..." and `W-2-3-7-8-1-5-6` digit by digit.
  test("SPEAKING says to hyphenate an identifier and drop the hash", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toContain("hyphenate it, one character per hyphen");
    expect(result).toContain('drop any\n  "#"');
    expect(result).toContain('"W-2-3-7-8-1-5-6"');
  });

  // A DIGIT-ONLY identifier was uncovered by the old wording ("mixes letters
  // and digits, or is not a word"), so a card's last four, an item number, a
  // ZIP and a phone number all fell to "say numbers the way a person says
  // them" and were said as quantities: `2478` is spoken "twenty-four
  // seventy-eight" and `7747408585` "seven billion seven hundred forty-seven
  // million...". 130 turns spoke a card's last four as one number, 71 an item
  // number.
  test("SPEAKING counts a digit-only code as an identifier", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toContain("names one record rather than counting something");
    expect(result).toContain("a card's last four");
    expect(result).toContain('"ending in 2-4-7-8"');
  });

  // `yusuf.rossi7301@example.com` is spoken "yusuf rossi seven thousand three
  // hundred one at example com", and `mei.kovacs8232@example.com` came out as
  // "may kuvax eight thousand two hundred thirty two xample dot com" — the
  // name itself different words and the domain's first letter eaten. Spelling
  // the local part instead is worse, not better: `y-u-s-u-f dot r-o-s-s-i,
  // seven-three-zero-one` lost the "at" entirely. 79 agent turns spoke a
  // literal address, and the caller asked for a repeat after 13.6% of the ones
  // that were delivered complete, against a 2.8% baseline.
  test("SPEAKING gives an email its own three-part spelling", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toContain("EMAIL ADDRESS is never written as one token");
    expect(result).toContain('"yusuf dot rossi, 7-3-0-1, at example dot com"');
    expect(result).toContain("Don't spell the letters either");
  });

  // 37.6% of agent utterances in those calls never reached a terminal
  // punctuation mark — the caller cut in first — and 7.8% of ALL turns lost a
  // number or price inside the cut tail ("the combined difference is a
  // sixteen-dollar and sixty-"). The reply-length rules already push the
  // ANSWER forward; this pushes the value the caller has to write down.
  test("SPEAKING puts a written-down value in the first sentence", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toContain("in your FIRST sentence");
    expect(result).toContain("a value saved for the end");
  });

  // Markdown is banned for brevity and for the text channel, NOT because it is
  // audible: `**641**`, `- ` bullets and newlines are all silent through this
  // TTS, as are `20%`, `11:30`, `2026-05-12`, `RGB`, `64GB` and curly quotes.
  // Pinned so a future reader does not "strengthen" the rule with a
  // pronunciation claim the voice does not support.
  test("SPEAKING does not claim markdown is mispronounced", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toContain("No markdown, bullet");
    expect(result).not.toContain("asterisk");
    expect(result).not.toContain("read aloud as");
  });

  // The contradiction this scope resolves: TOOLS said "never retype, reformat,
  // or construct an ID" with no direction attached, which reads as an
  // instruction to speak the id exactly as the tool result spelled it — the
  // one written form measured to be read out as a quantity. Two rules, one
  // saying hyphenate and one saying never reformat, resolve toward whichever
  // sits closer to the value, and the tool result always does.
  test("TOOLS scopes copy-exactly to what is SENT to a tool", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).toContain("exactly into what you SEND a\n  tool");
    expect(result).toContain("This is about tool\n  arguments only");
  });

  // Spoken "K dash 2" reached add_to_cart as "K-2" (expected "K2"), and a
  // spelled confirmation code "Z K 3 F F W" arrived as "ZEDK3FFW" — the
  // single most common tool error in tau2 was "User not found". These are
  // transcript-reading rules, so they live in LISTENING and apply even to a
  // tool-less agent that only has to repeat an identifier back.
  test.each([true, false])(
    "LISTENING writes spoken identifiers in written form (hasTools: %s)",
    (hasTools) => {
      const result = buildSystemPrompt(makeConfig(), { hasTools });
      expect(result).toContain('"K dash 2" is K2');
      expect(result).toContain("ZK3FFW, never ZEDK3FFW");
      expect(result).toContain("ordinary title case");
    },
  );

  // Verbose letter-by-letter readbacks make replies long and invite the
  // caller to interrupt mid-sentence (see tau2 turn-taking analysis).
  test("LISTENING forbids reading spelled input back letter by letter", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toContain("Don't read spelled input back letter by letter");
  });

  test("includes correctly formatted date string", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toContain(DATE_LINE);
  });

  test("date format uses en-US locale with weekday, month, day, and year", () => {
    // Advance to a different date to verify format consistency
    vi.setSystemTime(LOCAL_NOON(2025, 11, 31));
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toContain("Today's date is Wednesday, December 31, 2025.");
  });

  test("sections appear in correct order", () => {
    const result = buildSystemPrompt(makeConfig({ systemPrompt: "Custom rules." }), {
      hasTools: true,
      toolGuidance: ["- Guidance line."],
    });
    const indices = [
      result.indexOf("## PERSONALITY"),
      result.indexOf("## SPEAKING"),
      result.indexOf("## LISTENING"),
      result.indexOf("## TOOLS"),
      result.indexOf("Today's date is"),
      result.indexOf("Built-in tool usage:"),
      result.indexOf(AGENT_HEADER),
    ];
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(indices.every((i) => i > 0)).toBe(true);
  });

  // The invariant the section split exists to hold: one rule, one place. The
  // old base-prompt-plus-appended-blocks shape stated each of these twice, in
  // wording that had drifted apart — the base prompt allowed a filler opener
  // the voice rules banned, and capped the reply at "one or two sentences"
  // against the voice rules' two.
  test("no rule is stated twice in the assembled prompt", () => {
    const result = buildSystemPrompt(makeConfig({ systemPrompt: "Custom rules." }), {
      hasTools: true,
      voice: true,
      toolGuidance: ["- Guidance line."],
    });
    for (const phrase of [
      "No markdown, bullet",
      "FIRST sentence is at most eight words",
      "Keep the whole reply to two sentences",
      "letter by letter",
      "Today's date is",
      "## SPEAKING",
      "## TOOLS",
    ]) {
      expect(countOf(result, phrase), `"${phrase}" should appear exactly once`).toBe(1);
    }
  });

  test("empty custom instructions treated same as default", () => {
    const result = buildSystemPrompt(makeConfig({ systemPrompt: "" }), { hasTools: false });
    expect(result).not.toContain(AGENT_HEADER);
  });

  test("toolGuidance: [] omits the built-in tool usage section", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false, toolGuidance: [] });
    expect(result).not.toContain("Built-in tool usage:");
  });

  test("toolGuidance lines are joined with newlines under one header", () => {
    const result = buildSystemPrompt(makeConfig(), {
      hasTools: false,
      toolGuidance: ["- Use think before answering.", "- Use recall to look things up."],
    });
    expect(result).toContain(
      "\n\nBuilt-in tool usage:\n- Use think before answering.\n- Use recall to look things up.",
    );
  });

  // Exact-equality assertions: the prompt text is behavior (it steers the
  // LLM), so pin every assembled byte. Composed from the section constants
  // rather than re-typed prose — what this builder owns is the ORDER and the
  // separators, and a re-typed copy only ever pins the copy.
  test("minimal prompt is exactly the voice core plus the date", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toBe(`${VOICE_CORE}\n\n${DATE_LINE}`);
  });

  test("full prompt assembles every section verbatim", () => {
    const result = buildSystemPrompt(makeConfig({ systemPrompt: "Custom rules." }), {
      hasTools: true,
      voice: true,
      toolGuidance: ["- Guidance line."],
    });
    expect(result).toBe(
      [
        PROMPT_ROLE,
        PROMPT_PERSONALITY,
        PROMPT_SPEAKING,
        PROMPT_LISTENING,
        PROMPT_TOOLS,
        DATE_LINE,
        "Built-in tool usage:\n- Guidance line.",
        `${AGENT_HEADER}\nCustom rules.`,
      ].join("\n\n"),
    );
  });

  test("DEFAULT_SYSTEM_PROMPT is the full default: voice core plus tools", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toBe(`${VOICE_CORE}\n\n${PROMPT_TOOLS}`);
  });
});

describe("an author's prompt that interpolates DEFAULT_SYSTEM_PROMPT", () => {
  /**
   * The shape this constant's own docs recommended for a long time, on the
   * false premise that `agent({ systemPrompt })` REPLACES the defaults. It
   * appends, so following the advice sent the ~10,000-character voice core
   * twice.
   */
  const composed = `${DEFAULT_SYSTEM_PROMPT}\n\nOnly discuss items in the catalog.`;

  test("does not emit the voice core a second time", () => {
    const result = buildSystemPrompt(makeConfig({ systemPrompt: composed }), { hasTools: true });
    // Once, not twice. `PROMPT_ROLE` is the first section and the cheapest
    // witness — a doubled prompt contains it at two different offsets.
    expect(result.indexOf(PROMPT_ROLE)).toBe(result.lastIndexOf(PROMPT_ROLE));
    expect(result.split(PROMPT_LISTENING)).toHaveLength(2);
    expect(result.split(PROMPT_TOOLS)).toHaveLength(2);
  });

  test("keeps the author's own rules, under the agent header", () => {
    const result = buildSystemPrompt(makeConfig({ systemPrompt: composed }), { hasTools: true });
    expect(result.endsWith(`${AGENT_HEADER}\nOnly discuss items in the catalog.`)).toBe(true);
  });

  test("is byte-identical to writing only the domain rules, which is the documented form", () => {
    const opts = { hasTools: true } as const;
    expect(buildSystemPrompt(makeConfig({ systemPrompt: composed }), opts)).toBe(
      buildSystemPrompt(makeConfig({ systemPrompt: "Only discuss items in the catalog." }), opts),
    );
  });

  test("a prompt that is the default plus nothing adds no agent section at all", () => {
    const result = buildSystemPrompt(
      makeConfig({ systemPrompt: `${DEFAULT_SYSTEM_PROMPT}\n\n   ` }),
      { hasTools: true },
    );
    expect(result).not.toContain(AGENT_HEADER);
    // Identical to declaring no `systemPrompt` at all, which is what "the
    // default plus nothing" means.
    expect(result).toBe(buildSystemPrompt(makeConfig(), { hasTools: true }));
  });

  test("says so when it fires, rather than repairing the premise silently", () => {
    // The repair is what made the false premise survivable: an author who
    // interpolated saw a prompt that worked. One line is what turns it back
    // into something they can act on.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // A prompt of its own, so the once-per-prompt latch is not already spent by
    // another case in this file.
    const mine = `${DEFAULT_SYSTEM_PROMPT}\n\nOnly discuss the catalog, please.`;
    buildSystemPrompt(makeConfig({ systemPrompt: mine }), { hasTools: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("begins with a verbatim copy");
    expect(warn.mock.calls[0]?.[0]).toContain("APPENDED");
    // Once per prompt: the runtime rebuilds this string every calendar day.
    buildSystemPrompt(makeConfig({ systemPrompt: mine }), { hasTools: true });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test("a MID-STRING copy is warned about — the shape the old advice's own rationale produced", () => {
    // "Interpolate when part of the prompt is computed" puts the constant
    // anywhere but the front, which `stripDefaultPrefix` deliberately does not
    // repair. Unrepaired and unreported, it is ~10,000 duplicated characters a
    // turn under two precedence headers.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const computed = `Today's specials: pepperoni.\n\n${DEFAULT_SYSTEM_PROMPT}\n\nBe brief.`;
    const result = buildSystemPrompt(makeConfig({ systemPrompt: computed }), { hasTools: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("somewhere other than the start");
    expect(warn.mock.calls[0]?.[0]).toContain("TWICE");
    // Still not STRIPPED — the warning is the whole change, and the scope
    // boundary (drop a duplicate prefix, never edit prose) is unmoved.
    expect(result.endsWith(`${AGENT_HEADER}\n${computed}`)).toBe(true);
    warn.mockRestore();
  });

  test("a prompt that names none of it says nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    buildSystemPrompt(makeConfig({ systemPrompt: "Only discuss pizza." }), { hasTools: true });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("only a LEADING copy is stripped — a prompt that merely mentions it is untouched", () => {
    // The strip is a duplicate-prefix removal, not prose editing: a constant
    // interpolated mid-prompt stays where the author put it.
    const middle = `Be brief.\n\n${DEFAULT_SYSTEM_PROMPT}`;
    const result = buildSystemPrompt(makeConfig({ systemPrompt: middle }), { hasTools: true });
    expect(result.endsWith(`${AGENT_HEADER}\n${middle}`)).toBe(true);
  });

  test("a prompt that only RESEMBLES the default is appended verbatim", () => {
    const nearly = DEFAULT_SYSTEM_PROMPT.slice(1);
    const result = buildSystemPrompt(makeConfig({ systemPrompt: nearly }), { hasTools: true });
    expect(result.endsWith(`${AGENT_HEADER}\n${nearly}`)).toBe(true);
  });
});

/**
 * WHERE the opt-in presets land, which is the half `voice-presets.test.ts`
 * cannot see: that file owns the text and the composition, this one owns the
 * assembled prompt.
 */
describe("buildSystemPrompt with voicePresets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(LOCAL_NOON(2025, 0, 15));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("an agent that declares none sends the byte-identical prompt", () => {
    const before = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(buildSystemPrompt(makeConfig({ voicePresets: [] }), { hasTools: true })).toBe(before);
  });

  test("a preset lands AFTER the TOOLS section", () => {
    const result = buildSystemPrompt(makeConfig({ voicePresets: ["echoVerification"] }), {
      hasTools: true,
    });
    expect(result.indexOf(VOICE_PRESETS.echoVerification)).toBeGreaterThan(
      result.indexOf(PROMPT_TOOLS),
    );
  });

  test("a preset lands BEFORE the author's own instructions, which still win", () => {
    const custom = "Only discuss pizza.";
    const result = buildSystemPrompt(
      makeConfig({ systemPrompt: custom, voicePresets: ["natoAlphabet"] }),
      { hasTools: true },
    );
    expect(result.indexOf(VOICE_PRESETS.natoAlphabet)).toBeLessThan(result.indexOf(AGENT_HEADER));
    expect(result.endsWith(`${AGENT_HEADER}\n${custom}`)).toBe(true);
  });

  test("presets are emitted for a toolless session too", () => {
    const result = buildSystemPrompt(makeConfig({ voicePresets: ["smartMatching"] }), {
      hasTools: false,
    });
    expect(result).toContain(VOICE_PRESETS.smartMatching);
    expect(result).not.toContain(PROMPT_TOOLS);
  });

  test("each preset appears exactly once, whatever the list says", () => {
    const result = buildSystemPrompt(
      makeConfig({ voicePresets: ["natoAlphabet", "echoVerification", "natoAlphabet"] }),
      { hasTools: true },
    );
    expect(countOf(result, VOICE_PRESETS.natoAlphabet)).toBe(1);
    expect(countOf(result, VOICE_PRESETS.echoVerification)).toBe(1);
  });

  test("the date still comes last of the framework's own sections", () => {
    const result = buildSystemPrompt(makeConfig({ voicePresets: ["speechNormalization"] }), {
      hasTools: true,
    });
    expect(result.endsWith(DATE_LINE)).toBe(true);
  });
});
