// Copyright 2026 the AAI authors. MIT license.
// The slow tier's tool surface: the mandatory digest argument, the three
// channel tools, and the completion refusal. UNIT tier.

import type { ToolSchema } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";
import {
  ASK_USER,
  channelEffectOf,
  channelToolSchemas,
  completionRefusal,
  injectInstructionFor,
  STATE_SUMMARY_ARG,
  TASK_DONE,
  TELL_USER,
  takeSummary,
  withSummaryArg,
} from "./channel.ts";
import { classifyToolSchema } from "./view.ts";

const schemaOf = (overrides: Partial<ToolSchema> = {}): ToolSchema => ({
  type: "function",
  name: "change_address",
  description: "Change the shipping address on an order",
  parameters: {
    type: "object",
    properties: { orderId: { type: "string" }, address: { type: "string" } },
    required: ["orderId"],
  },
  ...overrides,
});

describe("withSummaryArg", () => {
  test("adds the digest argument and REQUIRES it", () => {
    const { schema, carriesSummary } = withSummaryArg(schemaOf());
    expect(carriesSummary).toBe(true);
    expect(schema.parameters.properties).toHaveProperty(STATE_SUMMARY_ARG);
    expect(schema.parameters.required).toEqual(["orderId", STATE_SUMMARY_ARG]);
  });

  test("a tool with no `required` list still requires it", () => {
    const { schema } = withSummaryArg(schemaOf({ parameters: { type: "object", properties: {} } }));
    expect(schema.parameters.required).toEqual([STATE_SUMMARY_ARG]);
  });

  test("the AUTHOR's own property of that name wins, and the tool is untouched", () => {
    // Overwriting it would change what their `execute` receives, and the strip
    // would then delete a required argument on the way in.
    const authors = schemaOf({
      parameters: {
        type: "object",
        properties: { [STATE_SUMMARY_ARG]: { type: "number" } },
        required: [STATE_SUMMARY_ARG],
      },
    });
    const { schema, carriesSummary } = withSummaryArg(authors);
    expect(carriesSummary).toBe(false);
    expect(schema).toBe(authors);
  });

  test("the original schema is not mutated", () => {
    const original = schemaOf();
    withSummaryArg(original);
    expect(original.parameters.properties).not.toHaveProperty(STATE_SUMMARY_ARG);
  });
});

describe("takeSummary", () => {
  test("removes the argument rather than passing it through", () => {
    // `executeToolCall` validates against the author's own `inputSchema`, and a
    // zod object refuses an unknown key — so leaving it in fails every gated
    // call with a schema error about a field the author never declared.
    const { summary, rest } = takeSummary({
      orderId: "o1",
      [STATE_SUMMARY_ARG]: "Changing the address now.",
    });
    expect(summary).toBe("Changing the address now.");
    expect(rest).toEqual({ orderId: "o1" });
  });

  test("an absent argument answers an empty summary and the same object", () => {
    const args = { orderId: "o1" };
    const { summary, rest } = takeSummary(args);
    expect(summary).toBe("");
    expect(rest).toBe(args);
  });

  test("a non-string summary is dropped, and the key still comes out", () => {
    const { summary, rest } = takeSummary({ orderId: "o1", [STATE_SUMMARY_ARG]: 42 });
    expect(summary).toBe("");
    expect(rest).toEqual({ orderId: "o1" });
  });
});

describe("channelToolSchemas", () => {
  const schemas = channelToolSchemas();

  test("three tools, and the digest argument is added by withSummaryArg like any other", () => {
    // NOT pre-added: doing it in both places made these look to
    // `withSummaryArg` like tools whose author had claimed the name, so the
    // session warned about its own channel on every boot.
    expect(schemas.map((s) => s.name)).toEqual([TELL_USER, ASK_USER, TASK_DONE]);
    for (const schema of schemas) {
      expect(schema.parameters.required).not.toContain(STATE_SUMMARY_ARG);
      const { carriesSummary, schema: wrapped } = withSummaryArg(schema);
      expect(carriesSummary).toBe(true);
      expect(wrapped.parameters.required).toContain(STATE_SUMMARY_ARG);
    }
  });

  test("task_done is `completes`, so the slow tier is not exempt from its own gate", () => {
    const done = schemas.find((s) => s.name === TASK_DONE);
    expect(done?.completes).toBe(true);
    expect(classifyToolSchema(done as ToolSchema).mutates).toBe(true);
  });

  test("tell_user and ask_user are NOT gated — they are how a refusal gets spoken", () => {
    for (const name of [TELL_USER, ASK_USER]) {
      const schema = schemas.find((s) => s.name === name) as ToolSchema;
      expect(schema.completes).toBeUndefined();
      expect(classifyToolSchema(schema).mutates).toBe(false);
    }
  });
});

describe("channelEffectOf", () => {
  test("classifies the three", () => {
    expect(channelEffectOf(TELL_USER, { text: "It is queued." })).toEqual({
      kind: "tell",
      text: "It is queued.",
    });
    expect(channelEffectOf(ASK_USER, { question: "Which order?" })).toEqual({
      kind: "ask",
      question: "Which order?",
    });
    expect(channelEffectOf(TASK_DONE, { result: "Address changed." })).toEqual({
      kind: "done",
      result: "Address changed.",
    });
  });

  test("an agent tool is not a channel call", () => {
    expect(channelEffectOf("change_address", { orderId: "o1" })).toBeUndefined();
  });

  test("an EMPTY payload is refused rather than injected", () => {
    // A `tell_user` with no text would inject a turn instructing the fast tier
    // to say nothing, which reaches the caller as an utterance about nothing.
    expect(channelEffectOf(TELL_USER, {})).toBeUndefined();
    expect(channelEffectOf(TELL_USER, { text: "   " })).toBeUndefined();
    expect(channelEffectOf(ASK_USER, { question: 7 })).toBeUndefined();
  });

  test("task_done with no result still reports done", () => {
    // The one asymmetry: the call is the signal, and refusing it would leave a
    // finished run unable to say so.
    expect(channelEffectOf(TASK_DONE, {})).toEqual({
      kind: "done",
      result: "(no outcome given)",
    });
  });
});

describe("injectInstructionFor", () => {
  test("hands the fast tier an INSTRUCTION, not the words", () => {
    // So the model says it in the register the rest of the call is in, with the
    // digest beside it.
    expect(injectInstructionFor({ kind: "tell", text: "queued" })).toMatch(/in your own words/);
    expect(injectInstructionFor({ kind: "ask", question: "which order" })).toMatch(/^Ask/);
    expect(injectInstructionFor({ kind: "done", result: "changed" })).toMatch(/finished/);
  });
});

describe("completionRefusal", () => {
  test("names what is outstanding, so the fast tier has something true to say", () => {
    expect(completionRefusal(["change_address"])).toContain("change_address is still outstanding");
    expect(completionRefusal(["a", "b"])).toContain("a, b are still outstanding");
  });
});
