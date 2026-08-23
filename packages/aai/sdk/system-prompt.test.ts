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
