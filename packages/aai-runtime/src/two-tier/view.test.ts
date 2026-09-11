// Copyright 2026 the AAI authors. MIT license.
// The information boundary and the config resolution. UNIT tier.
//
// The claim under test is the one the whole architecture's credibility rests
// on: the slow tier sees what the fast tier saw and nothing else. Most of that
// is enforced by the TYPE (`SlowTierView` is unconstructible outside
// `slowTierViewOf`, which the compiler checks and a test cannot), so what is
// left for a spec is the trimming and the classification.

import type { Message } from "@alexkroman1/aai";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";
import { classifyToolSchema, slowTierViewOf } from "./view.ts";

const schema = (overrides: Partial<ToolSchema>): ToolSchema => ({
  type: "function",
  name: "t",
  description: "d",
  parameters: { type: "object", properties: {} },
  ...overrides,
});

const lines = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => ({ role: "user" as const, content: `line ${i}` }));

describe("classifyToolSchema", () => {
  test("an UNDECLARED tool is not silently a read", () => {
    // It reports `false`, and `session.ts` logs the name once per session —
    // the point being that absence is a finding rather than an assumption.
    expect(classifyToolSchema(schema({})).mutates).toBe(false);
  });

  test("`completes` implies `mutates`", () => {
    // Ending an engagement is not undone by the next turn, so an author who
    // wrote only `completes: true` still gets the step treated as one-way.
    const entry = classifyToolSchema(schema({ completes: true }));
    expect(entry).toMatchObject({ mutates: true, completes: true });
  });

  test("carries the DESCRIPTION and not the JSON Schema", () => {
    // The description is what the policy a decision is made against arrives
    // in; the parameters are how the model shapes arguments.
    const entry = classifyToolSchema(schema({ description: "Change an address", mutates: true }));
    expect(entry).toEqual({
      name: "t",
      description: "Change an address",
      mutates: true,
      completes: false,
    });
    expect(entry).not.toHaveProperty("parameters");
  });
});

describe("slowTierViewOf", () => {
  const facts = {
    instructions: "Be helpful.",
    messages: lines(40),
    toolSchemas: [schema({ name: "look_up" }), schema({ name: "change", mutates: true })],
  };

  test("the window is the TAIL, bounded by contextMessages", () => {
    const view = slowTierViewOf(facts, { revision: 0, summary: "", entries: [] }, 5);
    expect(view.conversation).toHaveLength(5);
    expect(view.conversation[0]?.content).toBe("line 35");
    expect(view.conversation.at(-1)?.content).toBe("line 39");
  });

  test("a shorter conversation is not padded", () => {
    const view = slowTierViewOf(
      { ...facts, messages: lines(2) },
      { revision: 0, summary: "", entries: [] },
      24,
    );
    expect(view.conversation).toHaveLength(2);
  });

  test("a zero window hands over NOTHING rather than everything", () => {
    // `slice(-0)` is `slice(0)`, i.e. the whole list — the one arithmetic slip
    // in this function that would silently widen the boundary.
    const view = slowTierViewOf(facts, { revision: 0, summary: "", entries: [] }, 0);
    expect(view.conversation).toEqual([]);
  });

  test("carries the instructions and the classified catalogue, and no more", () => {
    const digest = { revision: 3, summary: "so far", entries: [] };
    const view = slowTierViewOf(facts, digest, 24);
    expect(view.instructions).toBe("Be helpful.");
    expect(view.catalog.map((t) => [t.name, t.mutates])).toEqual([
      ["look_up", false],
      ["change", true],
    ]);
    expect(view.digest).toBe(digest);
    // The boundary, as a shape assertion: these five keys and the brand.
    expect(Object.keys(view).sort()).toEqual(["catalog", "conversation", "digest", "instructions"]);
  });
});
