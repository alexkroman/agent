// Copyright 2026 the AAI authors. MIT license.
// Specs for the DECLARATION half of `ToolDef.messages`: what an author's
// shorthands normalize to, and what reaches the wire schema.
//
// CHOOSING between the declared lines is `tool-messages-select.test.ts`, beside
// the module that does it. The runtime half — the timers, the barge-in rules,
// the model skip — is `aai-runtime`'s `tool-messages-runner.test.ts` and
// `pipeline-tool-messages.test.ts`.

import { describe, expect, test } from "vitest";
import { agentToolsToSchemas } from "./_internal-types.ts";
import { DEFAULT_TOOL_START_PHRASES, normalizeToolMessages } from "./tool-messages.ts";

describe("normalizeToolMessages", () => {
  test("`start: true` is the default filler pool, as variants", () => {
    expect(normalizeToolMessages({ start: true })?.start).toEqual(
      DEFAULT_TOOL_START_PHRASES.map((content) => ({ content })),
    );
  });

  test("a bare string is one message, on every kind that takes one", () => {
    expect(normalizeToolMessages({ start: "Hold on." })?.start).toEqual([{ content: "Hold on." }]);
    expect(normalizeToolMessages({ complete: "Done." })?.complete).toEqual([{ content: "Done." }]);
    expect(normalizeToolMessages({ failed: "Sorry." })?.failed).toEqual([{ content: "Sorry." }]);
  });

  test("a tool that declares nothing normalizes to nothing", () => {
    // The property that keeps every existing agent's tool declarations
    // byte-identical: an absent `messages` must not become an empty object on
    // the wire, or every deployed schema changes shape for a field nobody set.
    expect(normalizeToolMessages(undefined)).toBeUndefined();
    expect(normalizeToolMessages({})).toBeUndefined();
    expect(normalizeToolMessages({ start: false })).toBeUndefined();
    expect(normalizeToolMessages({ start: [], delayed: [] })).toBeUndefined();
  });

  test("agentToolsToSchemas carries the normalized form, and only when there is one", () => {
    const [withMessages, without] = agentToolsToSchemas({
      lookup: {
        description: "d",
        messages: { start: "One sec.", complete: [{ role: "system", content: "summarize" }] },
        execute: () => undefined,
      },
      plain: { description: "d", execute: () => undefined },
    });
    expect(withMessages?.messages).toEqual({
      start: [{ content: "One sec." }],
      complete: [{ role: "system", content: "summarize" }],
    });
    expect(without).not.toHaveProperty("messages");
  });
});
