// Copyright 2026 the AAI authors. MIT license.
// The five knobs share ONE rule, and `MODEL_TUNING_FIELDS` is the mechanism
// that makes it un-skippable: `assertSamplingScope` derives its field list from
// this table rather than restating it, so the table is the only thing standing
// between a sixth knob and a setting an S2S agent may write and never have
// honoured. The `satisfies` catches a knob that skips the table at COMPILE
// time; what a runtime test can add is that the table really is what drives the
// refusal, and that every entry in it produces a usable sentence.

import { describe, expect, test } from "vitest";
import { rawConfig } from "./_test-utils.ts";
import type { AgentModelTuning, ModelTuningField } from "./agent-model-tuning.ts";
import { MODEL_TUNING_FIELDS } from "./agent-model-tuning.ts";
import { assemblyAIS2s } from "./providers/s2s/assemblyai.ts";

/** A legal value for each knob, so a case can set the field it names. */
const SAMPLE: { [K in ModelTuningField]: AgentModelTuning[K] } = {
  temperature: 0.2,
  maxOutputTokens: 400,
  maxRetries: 0,
  resetToolChoice: false,
  usageLimits: { totalTokens: 10_000 },
  twoTier: { effort: "high" },
};

const FIELDS = Object.keys(MODEL_TUNING_FIELDS) as ModelTuningField[];

describe("MODEL_TUNING_FIELDS", () => {
  test("holds exactly the six knobs, in the order the interface declares them", () => {
    // Pinned rather than derived from the interface, which has no runtime form:
    // the `satisfies` refuses a knob missing from the table AND an entry with no
    // field behind it, so this line is what makes a seventh knob a deliberate
    // edit here as well as a compile error there.
    expect(FIELDS).toEqual([
      "temperature",
      "maxOutputTokens",
      "maxRetries",
      "resetToolChoice",
      "usageLimits",
      "twoTier",
    ]);
  });

  test("every entry is a distinct noun phrase, because the refusal reads it aloud", () => {
    // `assertSamplingScope` splices the value into "it is ${description} for a
    // request this runtime assembles". An empty or duplicated one would make
    // two different refusals indistinguishable to the author reading them.
    const descriptions = Object.values(MODEL_TUNING_FIELDS);
    for (const description of descriptions) {
      expect(description).not.toBe("");
      // A noun phrase, not a sentence: it is spliced mid-clause.
      expect(description).not.toMatch(/^[A-Z]|\.$/);
    }
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });
});

describe("the table is what makes the s2s refusal un-skippable", () => {
  // Derived from MODEL_TUNING_FIELDS on purpose — the point of the table is
  // that a knob cannot be added without joining it, so the refusal cases must
  // come from the table rather than from a list someone keeps in step.
  for (const field of FIELDS) {
    test(`${field} is refused in s2s mode, quoting its own description`, () => {
      expect(() =>
        rawConfig({ name: "Line", s2s: assemblyAIS2s(), [field]: SAMPLE[field] }),
      ).toThrow(`${field} has no effect in s2s mode — it is ${MODEL_TUNING_FIELDS[field]} `);
    });

    test(`${field} survives to a PIPELINE config — the rule is s2s-only`, () => {
      expect(rawConfig({ name: "Line", [field]: SAMPLE[field] })[field]).toEqual(SAMPLE[field]);
    });

    test(`${field} survives to a TEXT config too — none of these is voice-specific`, () => {
      // The rule is "this runtime assembles the request", and a text agent
      // assembles its own — so text is the arm that tells the shared rule apart
      // from the pipeline-only voice knobs next door.
      expect(rawConfig({ name: "Docs", text: true, [field]: SAMPLE[field] })[field]).toEqual(
        SAMPLE[field],
      );
    });
  }

  test("an s2s agent that sets none of them is legal", () => {
    // The refusal is per FIELD, not per interface: the loop above must not be
    // reachable for an agent that declared nothing.
    expect(() => rawConfig({ name: "Line", s2s: assemblyAIS2s() })).not.toThrow();
  });

  test("`maxRetries: 0` survives — a `??` default would swallow it", () => {
    // Covered by the loop above (its sample IS 0) and named anyway: the value
    // most worth setting on a live call is the one an accidental `?? DEFAULT`
    // replaces with the vendor's own backoff, and a named case is what makes
    // that regression readable rather than a loop iteration going red.
    expect(rawConfig({ name: "Line", maxRetries: 0 }).maxRetries).toBe(0);
  });

  test("`resetToolChoice` is absent by default, so the runtime owns the default", () => {
    // It defaults TRUE, and the default lives in the runtime's step preparer —
    // a config that materialized `false` here would invert it silently.
    expect(rawConfig({ name: "Line" }).resetToolChoice).toBeUndefined();
  });
});

describe("UsageLimits", () => {
  test("totalTokens is the one bound, and it rides through as declared", () => {
    // A single field today, and deliberately: there is no COST limit, because a
    // price is a per-model, per-region number this package cannot carry. The
    // assertion is that the budget reaches the config as the number written —
    // nothing here clamps, defaults or rescales it.
    expect(rawConfig({ name: "Line", usageLimits: { totalTokens: 1 } }).usageLimits).toEqual({
      totalTokens: 1,
    });
  });

  test("an empty limits object is not a cap", () => {
    expect(rawConfig({ name: "Line", usageLimits: {} }).usageLimits).toEqual({});
  });
});
