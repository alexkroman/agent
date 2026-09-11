// Copyright 2026 the AAI authors. MIT license.
/**
 * What a prompt-fragment test can and cannot assert.
 *
 * It cannot assert that the model OBEYS a preset — that is an eval, it needs a
 * live model, and it is not what breaks. What breaks is the wiring and the
 * text: a preset that stops being emitted, one emitted twice, an order that
 * varies with how the author spelled the list, a load-bearing line edited away
 * by someone tightening prose, and a preset that quietly doubles in size while
 * being paid for on every model request.
 *
 * So this file pins four things: the composition (`voicePresetSection`), the
 * exact sentences each preset is FOR, the character budget behind the published
 * token cost, and — in `system-prompt.test.ts`, where the builder lives — where
 * the block lands in the assembled prompt.
 */

import { describe, expect, test } from "vitest";
import {
  VOICE_PRESET_NAMES,
  VOICE_PRESET_PRECEDENCE,
  VOICE_PRESETS,
  type VoicePresetName,
  voicePresetSection,
} from "./voice-presets.ts";

/**
 * The published cost of each preset, and the character band that holds it.
 *
 * Tokens are what an author pays and characters are what a test can count
 * without a tokenizer dependency, so the band is derived: each preset was
 * measured with `tiktoken`'s `o200k_base` (`cl100k_base` agrees within 5
 * tokens) and the band is ±25% of the measured character length. That is loose
 * enough for an honest edit and tight enough to fail the two things worth
 * failing — a preset that doubles, and a preset gutted to a stub.
 */
const MEASURED: Record<VoicePresetName, { tokens: number; chars: number }> = {
  echoVerification: { tokens: 191, chars: 799 },
  smartMatching: { tokens: 202, chars: 799 },
  speechNormalization: { tokens: 919, chars: 3105 },
  natoAlphabet: { tokens: 182, chars: 671 },
};

describe("VOICE_PRESETS", () => {
  test("every declared name has text, and nothing else does", () => {
    expect(Object.keys(VOICE_PRESETS)).toEqual([...VOICE_PRESET_NAMES]);
  });

  test.each(VOICE_PRESET_NAMES)("%s opens with its own markdown heading", (name) => {
    const text = VOICE_PRESETS[name];
    expect(text.startsWith("## ")).toBe(true);
    expect(text.split("\n")[0]).toBe(text.split("\n")[0]?.toUpperCase());
    // One heading per preset: two would make the precedence line ambiguous
    // about which section it governs.
    expect(text.split("\n").filter((line) => line.startsWith("## "))).toHaveLength(1);
  });

  test.each(VOICE_PRESET_NAMES)("%s stays inside its measured character band", (name) => {
    const { chars } = MEASURED[name];
    expect(VOICE_PRESETS[name].length).toBeGreaterThan(Math.round(chars * 0.75));
    expect(VOICE_PRESETS[name].length).toBeLessThan(Math.round(chars * 1.25));
  });

  test("the four together cost about 1,500 tokens, and one of them is most of it", () => {
    const total = Object.values(MEASURED).reduce((sum, m) => sum + m.tokens, 0);
    expect(total).toBeLessThan(1700);
    // The reason the field is a LIST and not a boolean: bundling would make
    // this one the price of the other three.
    expect(MEASURED.speechNormalization.tokens).toBeGreaterThan(
      MEASURED.echoVerification.tokens +
        MEASURED.smartMatching.tokens +
        MEASURED.natoAlphabet.tokens,
    );
  });

  test("no preset spends tokens on markdown a voice cannot speak", () => {
    // The body of a preset is read aloud by the same TTS the rest of the prompt
    // governs, and `PROMPT_SPEAKING` bans bullets and emphasis in OUTPUT — the
    // fragments themselves are instructions, so a `- ` bullet is fine, but a
    // fenced block or a heading level nothing renders is waste.
    for (const name of VOICE_PRESET_NAMES) {
      expect(VOICE_PRESETS[name]).not.toContain("```");
      expect(VOICE_PRESETS[name]).not.toContain("\n#");
    }
  });
});

describe("echoVerification", () => {
  const text = VOICE_PRESETS.echoVerification;

  test("carries the grouped read-back example verbatim", () => {
    expect(text).toContain(
      '"Just to confirm, your first name is Ryan, last name\n  is James — is that correct?"',
    );
  });

  test("asks for ONE grouped read-back rather than one per value", () => {
    expect(text).toContain("into ONE read-back");
    expect(text).toContain("three chances to be cut off");
  });

  test("spells only an uncommon name, which is what keeps it from repealing LISTENING", () => {
    expect(text).toContain("Spell an uncommon or ambiguous name letter by letter");
    expect(text).toContain("don't spell what nobody mishears");
  });

  test("names the values a voice agent actually gets wrong", () => {
    for (const kind of ["names", "phone numbers", "emails", "dates", "times", "addresses"]) {
      expect(text).toContain(kind);
    }
  });
});

describe("smartMatching", () => {
  const text = VOICE_PRESETS.smartMatching;

  test("carries the Brandon/Brendon case, which is the whole preset", () => {
    expect(text).toContain('you ask "Are you Brandon?", the transcript reads "Yes,');
    expect(text).toContain('this is Brendon" — that is a yes');
  });

  test("scopes the tolerance to a value the AGENT proposed", () => {
    expect(text).toContain("a NEAR-match on a value you proposed");
    expect(text).toContain("is a MATCH");
  });

  test("a SPELLED value REPLACES what was heard, which is the measured line", () => {
    // The tau2 baseline's caller spelled "S-O-F-I-A" and the agent went on
    // using "Sophia": the correction was in the audio and was thrown away.
    // "replaces", not "consider" — an averaged value is what failed.
    expect(text).toContain("the letters ARE the value: they");
    expect(text).toContain('REPLACE what you heard, exactly as spelled — "S-O-F-I-A" is Sofia');
    expect(text).toContain("every later lookup uses the spelled form");
  });

  test("covers the TOOL-ARGUMENT direction, not only the conversational one", () => {
    // The same run fed "Sophia Lee" into `find_user_id_by_name_zip`, retried
    // the identical string, and escalated. A miss is evidence about the
    // transcript, not about the record.
    expect(text).toContain("A name a lookup cannot find is a transcription to DOUBT");
    expect(text).toContain("Before you re-ask or hand off, retry its phonetic");
    expect(text).toContain("neighbours (Sofia/Sophia, Lee/Li)");
  });

  test("says why re-asking cannot work, not just that it is rude", () => {
    expect(text).toContain("asking again produces the same transcript");
  });

  test("still refuses a difference that changes who is meant", () => {
    expect(text).toContain("changes WHO or WHAT is meant");
  });
});

describe("speechNormalization", () => {
  const text = VOICE_PRESETS.speechNormalization;

  test("says the prompt-layer rule up front", () => {
    expect(text).toContain("read aloud verbatim, so write the WORDS, never\nthe written form");
  });

  test("renders money as words, with Retell's own example", () => {
    expect(text).toContain('"$758.08" is "seven fifty-eight dollars and eight cents"');
  });

  test("keeps the SPACED dash in the phone example — it is what makes the voice pause", () => {
    expect(text).toContain(
      '"415-892-3245" is\n"four one five - eight nine two - three two four five"',
    );
    expect(text).toContain("Don't omit the\nspace around the dash when speaking");
  });

  test("spells an email and says '@' aloud", () => {
    expect(text).toContain('"name@company.com" is\n"n-a-m-e-@-c-o-m-p-a-n-y-dot-com"');
    expect(text).toContain('say "at" for\n"@"');
  });

  test("reads a time the way a person does, and never as o'clock", () => {
    expect(text).toContain('"3:30 PM" is "Three thirty PM"');
    expect(text).toContain('never "o\'clock"');
  });

  test("covers each category the field list promises", () => {
    for (const heading of [
      "**Numbers.**",
      "**Money.**",
      "**Dates.**",
      "**Times.**",
      "**Phone numbers.**",
      "**Emails.**",
      "**Addresses.**",
      "**Codes and identifiers.**",
      "**Symbols, units and abbreviations.**",
    ]) {
      expect(text).toContain(heading);
    }
  });

  test("agrees with PROMPT_SPEAKING about identifiers rather than restating a rival rule", () => {
    expect(text).toContain('"ABC123" is\n"A-B-C-one-two-three", never "ABC one twenty-three"');
  });
});

describe("natoAlphabet", () => {
  const text = VOICE_PRESETS.natoAlphabet;

  test("carries the target read-back verbatim", () => {
    expect(text).toContain('"That\'s B as in Bravo, 7, K as in Kilo, 2 — correct?"');
  });

  test("lists all 26 words rather than naming the alphabet", () => {
    for (const word of [
      "Alfa",
      "Bravo",
      "Charlie",
      "Delta",
      "Echo",
      "Foxtrot",
      "Golf",
      "Hotel",
      "India",
      "Juliett",
      "Kilo",
      "Lima",
      "Mike",
      "November",
      "Oscar",
      "Papa",
      "Quebec",
      "Romeo",
      "Sierra",
      "Tango",
      "Uniform",
      "Victor",
      "Whiskey",
      "X-ray",
      "Yankee",
      "Zulu",
    ]) {
      expect(text).toContain(word);
    }
  });

  test("uses the NATO spellings, not the ones a model recalls", () => {
    // "Alpha", "Juliet" and "Xray" are the three it gets wrong unprompted, and
    // they are exactly the ones a caller then has to decode.
    expect(text).not.toContain("Alpha");
    expect(text).not.toContain("Juliet,");
    expect(text).not.toContain("Xray");
  });

  test("says the letter WITH its word", () => {
    expect(text).toContain('"B as in Bravo", never "Bravo"');
  });
});

describe("voicePresetSection", () => {
  test("an agent that declares none sends nothing", () => {
    expect(voicePresetSection(undefined)).toBeUndefined();
    expect(voicePresetSection([])).toBeUndefined();
  });

  test("one preset is the precedence line plus that preset, and nothing else", () => {
    expect(voicePresetSection(["smartMatching"])).toBe(
      `${VOICE_PRESET_PRECEDENCE}\n\n${VOICE_PRESETS.smartMatching}`,
    );
  });

  test.each(VOICE_PRESET_NAMES)("%s can be turned on alone", (name) => {
    const section = voicePresetSection([name]);
    expect(section).toContain(VOICE_PRESETS[name]);
    for (const other of VOICE_PRESET_NAMES.filter((n) => n !== name)) {
      expect(section).not.toContain(VOICE_PRESETS[other]);
    }
  });

  test("they compose, in declaration order rather than the author's", () => {
    const written = voicePresetSection(["natoAlphabet", "echoVerification"]);
    expect(written).toBe(
      [VOICE_PRESET_PRECEDENCE, VOICE_PRESETS.echoVerification, VOICE_PRESETS.natoAlphabet].join(
        "\n\n",
      ),
    );
    // Which is the point: two spellings of the same set produce one prompt.
    expect(voicePresetSection(["echoVerification", "natoAlphabet"])).toBe(written);
  });

  test("a repeated name is emitted once", () => {
    expect(voicePresetSection(["echoVerification", "echoVerification"])).toBe(
      voicePresetSection(["echoVerification"]),
    );
  });

  test("all four compose into one block with one precedence line", () => {
    const section = voicePresetSection(VOICE_PRESET_NAMES) ?? "";
    expect(section.split(VOICE_PRESET_PRECEDENCE)).toHaveLength(2);
    for (const name of VOICE_PRESET_NAMES) {
      expect(section).toContain(VOICE_PRESETS[name]);
    }
  });

  test("the precedence line names the two sections a preset may override", () => {
    expect(VOICE_PRESET_PRECEDENCE).toContain("SPEAKING or LISTENING above");
  });

  test("a name no preset owns contributes nothing rather than an empty section", () => {
    // Reachable only from a config that skipped the schema — a hand-written
    // `export default {…}`, or one round-tripped from an older wire format.
    // Typed as `readonly string[]` first, so reaching the arm costs ONE
    // narrowing assertion rather than the `as unknown as` a bare literal needs.
    const names: readonly string[] = ["notAPreset"];
    const stale = names as readonly VoicePresetName[];
    expect(voicePresetSection(stale)).toBeUndefined();
    expect(voicePresetSection([...stale, "smartMatching"])).toBe(
      voicePresetSection(["smartMatching"]),
    );
  });
});
