// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for `agent({ subagents })` — that a declared roster becomes an
 * ordinary tool the model routes with, that the routing information really
 * reaches the model (the enum AND each subagent's description), and the three
 * refusals, each of which stands in for a roster that would route badly with
 * nothing reporting it.
 */

import { describe, expect, it } from "vitest";
import { toAgentConfig } from "./agent-config.ts";
import { agent, tool } from "./define.ts";
import { type ToolInputSchema, toToolJsonSchema } from "./schema.ts";
import { subagent } from "./subagent.ts";
import { DELEGATE_TOOL_NAME } from "./subagent-roster.ts";
import { createToolContext } from "./testing.ts";
import { stubDelegate } from "./testing-delegate.ts";
import { withTools } from "./tool-registry.ts";
import type { ToolDef } from "./types.ts";
import { isToolFailure } from "./utils.ts";

const billing = subagent({
  name: "billing",
  description: "Answers billing, invoice and refund questions",
  systemPrompt: "You are the billing desk.",
});

const tech = subagent({
  name: "tech",
  description: "Diagnoses connection and hardware faults",
  systemPrompt: "You are technical support.",
});

const desk = agent({ name: "Front Desk", subagents: [billing, tech] });

/**
 * The minted tool, or a failure naming what was missing.
 *
 * A lookup rather than a module-level const, because every field the assertions
 * read is OPTIONAL on `ToolDef` and a `?.` chain turns "the tool was never
 * minted" into an assertion failure about `undefined` three lines later.
 */
function delegateTool(): {
  description: string;
  inputSchema: ToolInputSchema;
  execute: ToolDef["execute"];
} {
  const def = desk.tools[DELEGATE_TOOL_NAME];
  if (!def?.inputSchema) throw new Error(`no ${DELEGATE_TOOL_NAME} tool with an input schema`);
  return { description: def.description, inputSchema: def.inputSchema, execute: def.execute };
}

describe("agent({ subagents })", () => {
  it("publishes the roster as one ordinary tool", () => {
    expect(Object.keys(desk.tools)).toEqual([DELEGATE_TOOL_NAME]);
    expect(typeof delegateTool().execute).toBe("function");
  });

  it("declares no tool when there is no roster", () => {
    expect(agent({ name: "Plain" }).tools).toEqual({});
  });

  it("tells the model what each subagent is FOR, not just its name", () => {
    expect(delegateTool().description).toContain("- billing: Answers billing, invoice and refund");
    expect(delegateTool().description).toContain(
      "- tech: Diagnoses connection and hardware faults",
    );
  });

  it("makes the subagent argument an enum over the roster", () => {
    const schema = toToolJsonSchema(delegateTool().inputSchema);
    const chosen = (schema.properties as Record<string, { enum?: string[] }>).subagent;
    expect(chosen?.enum).toEqual(["billing", "tech"]);
    expect(schema.required).toEqual(["subagent", "task"]);
  });

  it("routes the task to the subagent the model named", async () => {
    const model = stubDelegate({ billing: "Refunded on the 3rd.", tech: "Reboot the modem." });
    const ctx = createToolContext({ delegate: model.delegate });

    const result = await delegateTool().execute(
      { subagent: "billing", task: "Was invoice 41 refunded?", context: "Account 900." },
      ctx,
    );

    expect(result).toEqual({ subagent: "billing", answer: "Refunded on the 3rd.", lookups: 0 });
    // The whole brief goes to the subagent, which has heard none of the call.
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.subagent.name).toBe("billing");
    expect(model.calls[0]?.task).toBe("Was invoice 41 refunded?");
    expect(model.calls[0]?.options.context).toBe("Account 900.");
  });

  it("reports the lookups a run made, so the agent can narrate the wait", async () => {
    const model = stubDelegate({
      tech: { text: "Reboot the modem.", toolCalls: [{ name: "kb_search", input: {} }] },
    });

    const result = await delegateTool().execute(
      { subagent: "tech", task: "No sync light." },
      createToolContext({ delegate: model.delegate }),
    );

    expect(result).toMatchObject({ lookups: 1 });
  });

  it("surfaces an answer the subagent's own guardrail never accepted", async () => {
    const model = stubDelegate({
      tech: { text: "Try turning it off.", complaint: "No diagnostic step was run." },
    });

    const result = await delegateTool().execute(
      { subagent: "tech", task: "No sync light." },
      createToolContext({ delegate: model.delegate }),
    );

    // A field whose PRESENCE is the warning — an accepted answer carries none.
    expect(result).toMatchObject({
      answer: "Try turning it off.",
      unverified: "No diagnostic step was run.",
    });
  });

  it("refuses a subagent the roster does not hold, naming the ones it does", async () => {
    const model = stubDelegate({ billing: "x" });

    // The enum makes this unreachable through a well-behaved provider; a
    // repaired or salvaged tool call is not one.
    const result = await delegateTool().execute(
      { subagent: "shipping", task: "Where is it?" },
      createToolContext({ delegate: model.delegate }),
    );

    expect(isToolFailure(result)).toBe(true);
    expect((result as { error: string }).error).toBe(
      'There is no subagent called "shipping". Available: billing, tech.',
    );
    expect(model.calls).toEqual([]);
  });
});

describe("agent({ subagents }) refusals", () => {
  it("refuses a roster entry with no description", () => {
    const anonymous = subagent({ name: "billing", systemPrompt: "You are the billing desk." });
    expect(() => agent({ name: "Desk", subagents: [anonymous] })).toThrow(
      /"billing" is on this agent's roster and has no `description`/,
    );
  });

  it("refuses two subagents with one name", () => {
    expect(() => agent({ name: "Desk", subagents: [billing, { ...billing }] })).toThrow(
      /Two subagents on this agent's roster are called "billing"/,
    );
  });

  it("refuses an empty roster rather than publishing a tool with no one on it", () => {
    expect(() => agent({ name: "Desk", subagents: [] })).toThrow(/roster with nobody on it/);
  });
});

describe("a roster and the rest of the agent", () => {
  it("reports a tools/ file that collides with the minted tool", () => {
    const mine = tool({ description: "mine", execute: () => "x" });
    expect(() => withTools(desk, { [DELEGATE_TOOL_NAME]: mine })).toThrow(
      /collides with a tool this agent's definition already declares/,
    );
  });

  it("still reports an ordinary double declaration when there is no roster", () => {
    const plain = {
      ...agent({ name: "Plain" }),
      tools: { echo: tool({ description: "d", execute: () => "x" }) },
    };
    expect(() =>
      withTools(plain, { echo: tool({ description: "d", execute: () => "x" }) }),
    ).toThrow(/The tool "echo" is declared twice/);
  });

  it("keeps a roster off the wire while its tool stays on the definition", () => {
    const config = toAgentConfig(desk) as Record<string, unknown>;
    expect(config.subagents).toBeUndefined();
    expect(config.tools).toBeUndefined();
    // What actually travels is the SCHEMA, taken off `tools` by the bundle entry
    // exactly as it is for a file-declared tool.
    expect(desk.tools[DELEGATE_TOOL_NAME]).toBeDefined();
  });
});
