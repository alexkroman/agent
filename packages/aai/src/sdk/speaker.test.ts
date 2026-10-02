// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { DEFAULT_GUARDRAIL_MAX_REVISIONS, type SpeakerDef, speaker } from "./speaker.ts";

describe("speaker", () => {
  test("is an identity function — the definition comes back as the same object", () => {
    const def = { name: "billing", systemPrompt: "Handle billing." };
    expect(speaker(def)).toBe(def);
  });

  test("infers the name as a literal, so a roster can key on it", () => {
    const billing = speaker({ name: "billing", systemPrompt: "Handle billing." });
    expectTypeOf(billing.name).toEqualTypeOf<"billing">();
    expectTypeOf(billing).toExtend<SpeakerDef<"billing">>();
  });

  test("types the schema's OUTPUT, for a delegate that answers structured data", () => {
    const Answer = z.object({ total: z.number() });
    const researcher = speaker({ name: "researcher", systemPrompt: "Find it.", schema: Answer });
    expect(researcher.schema).toBe(Answer);
    expectTypeOf(researcher.name).toEqualTypeOf<"researcher">();
  });
});

describe("DEFAULT_GUARDRAIL_MAX_REVISIONS", () => {
  test("lets a guardrail send an answer back once, and only once, by default", () => {
    expect(DEFAULT_GUARDRAIL_MAX_REVISIONS).toBe(1);
  });
});
