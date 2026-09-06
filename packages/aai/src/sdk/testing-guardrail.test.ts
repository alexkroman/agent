// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { type GuardrailVerdict, subagent } from "./subagent.ts";
import { runGuardrail } from "./testing-guardrail.ts";

const checker = subagent({
  name: "fact-checker",
  systemPrompt: "Check.",
  guardrail: ({ text, toolCalls }) => {
    if (toolCalls.length === 0 && text.startsWith("Unverified")) return "Look something up.";
    return /^(Confirmed|Contradicted|Unclear):/.test(text) || "Open with a verdict word.";
  },
});

describe("runGuardrail", () => {
  test("returns the verdict — true, or the complaint", () => {
    expect(runGuardrail(checker, "Confirmed: the figure is 12%.")).toBe(true);
    expect(runGuardrail(checker, "It seems prices fell.")).toBe("Open with a verdict word.");
  });

  test("hands the guardrail a zero cost report by default, which `answer` overrides", () => {
    expect(runGuardrail(checker, "Unverified: nothing found.")).toBe("Look something up.");
    expect(
      runGuardrail(checker, "Unverified: nothing found.", {
        toolCalls: [{ name: "web_search", input: { query: "prices" } }],
        steps: 3,
      }),
    ).toBe("Open with a verdict word.");
  });

  test("throws when the def declares no guardrail, rather than accepting by default", () => {
    const plain = subagent({ name: "researcher", systemPrompt: "Research." });
    expect(() => runGuardrail(plain, "anything")).toThrow(
      'runGuardrail: subagent "researcher" declares no guardrail.',
    );
  });

  test("throws when the guardrail is asynchronous, naming what to do instead", () => {
    const slow = subagent({
      name: "slow",
      systemPrompt: "Check slowly.",
      guardrail: async (): Promise<GuardrailVerdict> => true,
    });
    expect(() => runGuardrail(slow, "anything")).toThrow(/returned a promise/);
  });
});
