// Copyright 2026 the AAI authors. MIT license.
/**
 * What the "Session mode resolved" line says about each stage.
 *
 * `runtime.test.ts` asserts the line is EMITTED and carries the effective
 * defaults, which is the property that matters most; this suite is about the
 * one transformation between a resolver's answer and the log — a setting too
 * big to print. It is here rather than there because that file is at the
 * test-length cap and because the subject is this module.
 */

import { assemblyAIStt } from "@alexkroman1/aai/stt";
import { describe, expect, test } from "vitest";
import { describeResolvedProviders } from "./_provider-settings.ts";

describe("describeResolvedProviders", () => {
  test("a setting too big for one line is reported as its SIZE", () => {
    // A keyterm list runs to 100 entries and an agent context to 1,500
    // characters. Printed in full either one buries the endpointing window a
    // reader opened this line to find — and the value is still dialled, so
    // what is lost is the contents rather than the fact.
    const described = describeResolvedProviders({
      mode: "pipeline",
      stt: assemblyAIStt({
        keyterms: ["gift card", "order number", "exchange", "store credit", "PayPal"],
        agentContext: "x".repeat(200),
        languages: ["en", "es"],
      }),
    });
    expect(described.stt).toMatchObject({
      kind: "assemblyai",
      keyterms: "5 item(s)",
      agentContext: "200 chars",
      // A short list still prints in full: the threshold is "longer than a
      // glance", and which languages a session pins is a glance.
      languages: ["en", "es"],
      // And the settings a reader came for are untouched by the squash.
      minTurnSilenceMs: 1600,
    });
  });

  test("an absent stage is an absent key, never a defaulted vendor", () => {
    const described = describeResolvedProviders({ mode: "pipeline" });
    expect(described).toEqual({ stt: undefined, llm: undefined, tts: undefined });
  });
});
